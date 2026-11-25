//! git2 接入层：仓库状态、diff 解析、hunk 级操作、提交。
//!
//! 设计要点：
//! - 高频只读操作（status / diff）走 libgit2；
//! - patch 应用（hunk 级 stage / discard）沿用 git 生态通用做法，
//!   由本模块拼出**最小可用 patch 文本**后交给系统 `git apply` 执行，
//!   避免在 libgit2 里手工重建 partial diff 的复杂度。

#![allow(dead_code)] // `open` / `init` / `debug_dump_patch` 等为后续能力预留

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use git2::{
    Delta, Diff, DiffFormat, DiffOptions, IndexAddOption, Repository, StatusOptions,
};

use crate::error::{AppError, AppResult};
use crate::model::{
    ChangedFile, CommitResult, FileDiff, FilePair, FileStatus, Hunk, HunkLine, HunkLineKind,
    RepoStatus, StageArea,
};

// ---------------------------------------------------------------------------
// patch 原始文本解析
// ---------------------------------------------------------------------------

/// 从 `git diff` 原始补丁文本中解析出的单文件补丁。
struct RawFilePatch {
    /// 文件头（`diff --git`、`index`、`---`、`+++`、`new file mode` 等），
    /// 用于重建 patch 时原样带回去。
    header: String,
    /// 每个 hunk 的原始文本（含 `@@` 行）。
    hunks: Vec<RawHunk>,
}

struct RawHunk {
    header: String,
    body: String,
}

impl RawFilePatch {
    /// 由文件头 + 指定 hunk 组成一个可被 `git apply` 接受的最小 patch。
    fn build(&self, hunk_index: usize) -> AppResult<String> {
        let hunk = self.hunks.get(hunk_index).ok_or(AppError::HunkOutOfRange {
            index: hunk_index,
            total: self.hunks.len(),
        })?;

        let mut out = String::new();
        out.push_str(&self.header);
        out.push_str(&hunk.header);
        out.push_str(&hunk.body);
        Ok(out)
    }

    /// 是否包含 rename 元信息（rename 场景暂不做 hunk 级操作）。
    fn is_rename(&self) -> bool {
        self.header.contains("rename from ") || self.header.contains("rename to ")
    }
}

/// 解析完整补丁文本，按 `diff --git` 切分文件。
fn parse_patch(text: &str) -> Vec<RawFilePatch> {
    let mut files: Vec<RawFilePatch> = Vec::new();
    let mut cur: Option<RawFilePatch> = None;
    let mut cur_hunk: Option<RawHunk> = None;

    for line in text.split_inclusive('\n') {
        let is_file_start = line.starts_with("diff --git ");
        let is_hunk_start = line.starts_with("@@");

        if is_file_start {
            if let Some(h) = cur_hunk.take() {
                if let Some(f) = cur.as_mut() {
                    f.hunks.push(h);
                }
            }
            if let Some(f) = cur.take() {
                files.push(f);
            }
            cur = Some(RawFilePatch {
                header: line.to_string(),
                hunks: Vec::new(),
            });
            continue;
        }

        let Some(file) = cur.as_mut() else {
            continue;
        };

        if is_hunk_start {
            if let Some(h) = cur_hunk.take() {
                file.hunks.push(h);
            }
            cur_hunk = Some(RawHunk {
                header: line.to_string(),
                body: String::new(),
            });
            continue;
        }

        match cur_hunk.as_mut() {
            Some(h) => h.body.push_str(line),
            None => file.header.push_str(line),
        }
    }

    if let Some(h) = cur_hunk.take() {
        if let Some(f) = cur.as_mut() {
            f.hunks.push(h);
        }
    }
    if let Some(f) = cur.take() {
        files.push(f);
    }

    files
}

/// 解析 `@@ -a,b +c,d @@ heading`，返回 (old_start, old_lines, new_start, new_lines, heading)。
fn parse_hunk_header(header: &str) -> (u32, u32, u32, u32, String) {
    let trimmed = header.trim_end_matches(['\n', '\r']);
    let Some(rest) = trimmed.strip_prefix("@@ ") else {
        return (0, 0, 0, 0, String::new());
    };

    let mut old_start = 0u32;
    let mut old_lines = 1u32;
    let mut new_start = 0u32;
    let mut new_lines = 1u32;

    for (i, token) in rest.split(' ').enumerate() {
        if i == 0 {
            let t = token.trim_start_matches('-');
            let mut parts = t.split(',');
            old_start = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            old_lines = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
        } else if i == 1 {
            let t = token.trim_start_matches('+');
            let mut parts = t.split(',');
            new_start = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            new_lines = parts.next().and_then(|v| v.parse().ok()).unwrap_or(1);
        } else {
            break;
        }
    }

    // heading 是 `@@` 之后的部分
    let heading = trimmed
        .rfind("@@")
        .map(|pos| trimmed[pos + 2..].trim().to_string())
        .unwrap_or_default();

    (old_start, old_lines, new_start, new_lines, heading)
}

/// 把 hunk 原始 body 解析为带行号的 `HunkLine` 列表。
fn parse_hunk_lines(body: &str, old_start: u32, new_start: u32) -> Vec<HunkLine> {
    let mut lines: Vec<HunkLine> = Vec::new();
    let mut old_no = old_start;
    let mut new_no = new_start;

    for raw in body.split_inclusive('\n') {
        let line = raw.strip_suffix('\n').unwrap_or(raw);
        let line = line.strip_suffix('\r').unwrap_or(line);

        if line.is_empty() {
            continue;
        }

        let prefix = line.chars().next().unwrap_or(' ');

        // `\ No newline at end of file` 标记作用于上一行
        if prefix == '\\' {
            if let Some(last) = lines.last_mut() {
                last.no_newline = true;
            }
            continue;
        }

        let content = line.get(1..).unwrap_or("").to_string();

        let (kind, old_lineno, new_lineno) = match prefix {
            '+' => {
                let n = Some(new_no);
                new_no += 1;
                (HunkLineKind::Addition, None, n)
            }
            '-' => {
                let o = Some(old_no);
                old_no += 1;
                (HunkLineKind::Deletion, o, None)
            }
            ' ' => {
                let o = Some(old_no);
                let n = Some(new_no);
                old_no += 1;
                new_no += 1;
                (HunkLineKind::Context, o, n)
            }
            // 兼容为空行被裁剪上下文前缀的情况
            _ => {
                let o = Some(old_no);
                let n = Some(new_no);
                old_no += 1;
                new_no += 1;
                (HunkLineKind::Context, o, n)
            }
        };

        lines.push(HunkLine {
            kind,
            content,
            old_lineno,
            new_lineno,
            no_newline: false,
        });
    }

    lines
}

// ---------------------------------------------------------------------------
// 仓库状态
// ---------------------------------------------------------------------------

fn head_tree(repo: &Repository) -> Option<git2::Tree<'_>> {
    repo.head()
        .ok()
        .and_then(|h| h.peel_to_tree().ok())
}

/// 取得**最新**的索引快照。
///
/// `Repository::index()` 返回的是内存中的索引，若同一 `Repository` 实例上
/// 刚刚执行过 add / reset，需要 `read()` 刷新，否则读到的是过期内容。
/// 所有只读路径都必须经由本函数取索引。
fn fresh_index(repo: &Repository) -> AppResult<git2::Index> {
    let mut index = repo.index()?;
    index.read(true)?;
    Ok(index)
}

/// rename / copy 检测参数。默认阈值（50%）对常见重命名足够。
fn similar_opts() -> git2::DiffFindOptions {
    let mut o = git2::DiffFindOptions::new();
    o.renames(true).copies(false).rename_threshold(50);
    o
}

/// 读取仓库状态：分支、ahead/behind、三组变更文件。
pub fn read_status(repo: &Repository) -> AppResult<RepoStatus> {
    let workdir = repo
        .workdir()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .ok_or(AppError::NoRepo)?;

    let (branch, detached) = match repo.head() {
        Ok(head) => {
            let detached = repo.head_detached().unwrap_or(false);
            let mut name = head.shorthand().map(|s| s.to_string());
            if detached {
                if let Some(target_oid) = head.target() {
                    let short_oid = if target_oid.to_string().len() >= 7 {
                        target_oid.to_string()[..7].to_string()
                    } else {
                        target_oid.to_string()
                    };

                    let mut matched_ref = None;
                    if let Ok(branches) = repo.branches(None) {
                        for (b, _) in branches.flatten() {
                            if b.get().target() == Some(target_oid) {
                                if let Ok(Some(bname)) = b.name() {
                                    matched_ref = Some(bname.to_string());
                                    break;
                                }
                            }
                        }
                    }

                    if matched_ref.is_none() {
                        if let Ok(tags) = repo.tag_names(None) {
                            for t in tags.iter().flatten() {
                                if let Ok(r) = repo.resolve_reference_from_short_name(t) {
                                    if r.peel_to_commit().map(|c| c.id()).ok() == Some(target_oid) {
                                        matched_ref = Some(t.to_string());
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    name = Some(matched_ref.unwrap_or(short_oid));
                }
            }
            (name, detached)
        }
        Err(_) => (None, false),
    };

    let (ahead, behind) = ahead_behind(repo);

    let mut staged: Vec<ChangedFile> = Vec::new();
    let mut unstaged: Vec<ChangedFile> = Vec::new();
    let mut untracked: Vec<ChangedFile> = Vec::new();

    let tree = head_tree(repo);
    let index = fresh_index(repo)?;

    // 已暂存：HEAD -> index
    let mut staged_opts = DiffOptions::new();
    staged_opts.include_typechange(true);
    if let Ok(mut diff) = repo.diff_tree_to_index(tree.as_ref(), Some(&index), Some(&mut staged_opts)) {
        // rename 检测要在 Diff 上做；开启后重命名不会被拆成「删除 + 新增」
        let mut find = similar_opts();
        let _ = diff.find_similar(Some(&mut find));
        collect_files(&diff, StageArea::Staged, &mut staged)?;
    }

    // 未暂存：index -> workdir（不含未跟踪，未跟踪单独来自 statuses）
    let mut opts = DiffOptions::new();
    opts.include_untracked(false).include_typechange(true);
    if let Ok(diff) = repo.diff_index_to_workdir(Some(&index), Some(&mut opts)) {
        collect_files(&diff, StageArea::Unstaged, &mut unstaged)?;
    }

    // 未跟踪 + 冲突
    let mut sopts = StatusOptions::new();
    sopts
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true);

    if let Ok(statuses) = repo.statuses(Some(&mut sopts)) {
        for entry in statuses.iter() {
            let status = entry.status();
            let Some(path) = entry.path() else { continue };
            let path = path.replace('\\', "/");

            if status.is_conflicted() {
                unstaged.push(ChangedFile {
                    path,
                    old_path: None,
                    status: FileStatus::Conflicted,
                    area: StageArea::Unstaged,
                    additions: 0,
                    deletions: 0,
                    binary: false,
                });
                continue;
            }

            if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
                let is_index_new = status.contains(git2::Status::INDEX_NEW);
                let is_wt_new = status.contains(git2::Status::WT_NEW);

                if is_index_new && !is_wt_new {
                    // 已 add 的新文件由 staged diff 覆盖，这里跳过
                    continue;
                }

                untracked.push(ChangedFile {
                    path,
                    old_path: None,
                    status: FileStatus::Untracked,
                    area: StageArea::Untracked,
                    additions: 0,
                    deletions: 0,
                    binary: false,
                });
            }
        }
    }

    // 未跟踪文件补上新增行数（逐文件 diff，成本可接受）
    fill_untracked_stats(repo, &mut untracked);

    staged.sort_by(|a, b| a.path.cmp(&b.path));
    unstaged.sort_by(|a, b| a.path.cmp(&b.path));
    untracked.sort_by(|a, b| a.path.cmp(&b.path));

    Ok(RepoStatus {
        workdir,
        branch,
        detached,
        ahead,
        behind,
        staged,
        unstaged,
        untracked,
    })
}

fn ahead_behind(repo: &Repository) -> (u32, u32) {
    let Ok(head) = repo.head() else {
        return (0, 0);
    };
    if !head.is_branch() {
        return (0, 0);
    }
    let Some(name) = head.shorthand() else {
        return (0, 0);
    };
    let Ok(branch) = repo.find_branch(name, git2::BranchType::Local) else {
        return (0, 0);
    };
    let Ok(upstream) = branch.upstream() else {
        return (0, 0);
    };
    let (Some(local), Some(remote)) = (branch.get().target(), upstream.get().target()) else {
        return (0, 0);
    };
    repo.graph_ahead_behind(local, remote)
        .map(|(a, b)| (a as u32, b as u32))
        .unwrap_or((0, 0))
}

fn collect_files(
    diff: &Diff<'_>,
    area: StageArea,
    out: &mut Vec<ChangedFile>,
) -> AppResult<()> {
    let deltas = diff.deltas();
    let total = deltas.len();
    // 变更文件数量较多时跳过耗时的全文 Patch 逐行解析，秒级即刻返回
    let compute_line_stats = total <= 50;

    for (idx, delta) in deltas.enumerate() {
        let Some(file) = delta_to_changed_file(&delta, area, None) else {
            continue;
        };
        let mut entry = file;

        if compute_line_stats && !entry.binary {
            if let Ok(Some(patch)) = git2::Patch::from_diff(diff, idx) {
                if let Ok((_, add, del)) = patch.line_stats() {
                    entry.additions = add as u32;
                    entry.deletions = del as u32;
                }
            }
        }

        out.push(entry);
    }
    Ok(())
}

fn delta_to_changed_file(
    delta: &git2::DiffDelta<'_>,
    area: StageArea,
    _stats: Option<(u32, u32)>,
) -> Option<ChangedFile> {
    let status = match delta.status() {
        Delta::Added | Delta::Untracked => {
            if matches!(area, StageArea::Untracked) {
                FileStatus::Untracked
            } else {
                FileStatus::Added
            }
        }
        Delta::Deleted => FileStatus::Deleted,
        Delta::Modified => FileStatus::Modified,
        Delta::Renamed => FileStatus::Renamed,
        Delta::Typechange => FileStatus::TypeChange,
        Delta::Conflicted => FileStatus::Conflicted,
        Delta::Copied => FileStatus::Added,
        _ => return None,
    };

    let new_path = delta
        .new_file()
        .path()
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    let old_path = delta
        .old_file()
        .path()
        .map(|p| p.to_string_lossy().replace('\\', "/"));

    let path = new_path
        .clone()
        .or_else(|| old_path.clone())?;

    let binary = delta.new_file().is_binary() || delta.old_file().is_binary();

    Some(ChangedFile {
        path,
        old_path: if status == FileStatus::Renamed || status == FileStatus::Deleted {
            old_path.filter(|p| Some(p) != new_path.as_ref())
        } else {
            None
        },
        status,
        area,
        additions: 0,
        deletions: 0,
        binary,
    })
}

/// 为未跟踪文件补上新增行数统计。
///
/// libgit2 不会为未跟踪文件产出带内容的 delta（只给一个空 delta），
/// 因此 `Patch::line_stats()` 拿不到行数。这里直接读取文件统计行数，
/// 与 `synthesize_untracked_diff` 的口径保持一致。
fn fill_untracked_stats(repo: &Repository, files: &mut [ChangedFile]) {
    use std::io::Read as _;

    const MAX_UNTRACKED_STAT_BYTES: u64 = 2 * 1024 * 1024;
    const SNIFF_BYTES: usize = 8000;

    let Some(workdir) = repo.workdir() else {
        return;
    };
    for entry in files.iter_mut() {
        let abs = workdir.join(&entry.path);
        let Ok(meta) = std::fs::metadata(&abs) else {
            continue;
        };
        if !meta.is_file() || meta.len() > MAX_UNTRACKED_STAT_BYTES {
            entry.binary = true;
            continue;
        }
        let Ok(mut file) = std::fs::File::open(&abs) else {
            continue;
        };
        let mut sniff = [0u8; SNIFF_BYTES];
        let Ok(n) = file.read(&mut sniff) else {
            continue;
        };
        if sniff[..n].contains(&0) {
            entry.binary = true;
            continue;
        }
        let bytes = if n < SNIFF_BYTES {
            sniff[..n].to_vec()
        } else {
            let mut rest = Vec::with_capacity(meta.len() as usize);
            rest.extend_from_slice(&sniff[..n]);
            if file.read_to_end(&mut rest).is_err() {
                continue;
            }
            rest
        };
        let text = String::from_utf8_lossy(&bytes);
        let lines = count_lines(&text);
        entry.additions = lines;
        entry.deletions = 0;
    }
}

/// 统计文本行数，口径与 diff hunk 一致：末尾有换行时最后一行不额外计数。
fn count_lines(text: &str) -> u32 {
    if text.is_empty() {
        return 0;
    }
    let mut n = text.matches('\n').count() as u32;
    if !text.ends_with('\n') {
        n += 1;
    }
    n
}

// ---------------------------------------------------------------------------
// 单文件 diff
// ---------------------------------------------------------------------------

/// 取单文件 diff（含结构化 hunk 与原始 patch 文本）。
///
/// 注意两个 libgit2 行为：
/// 1. `Repository::index()` 返回内存缓存的索引快照。执行过 stage/unstage 后
///    必须用 `index.read()` 重新加载，否则会读到过期内容。
/// 2. 未跟踪文件在 `diff_index_to_workdir` 中只会产生一个**空** delta（没有
///    hunk），因此需要自行读取文件内容合成「纯新增」hunk 与对应 patch。
fn file_diff_raw(
    repo: &Repository,
    path: &str,
    area: StageArea,
) -> AppResult<(FileDiff, Option<RawFilePatch>)> {
    let index = fresh_index(repo)?;
    let normalized = path.replace('\\', "/");

    // 未跟踪文件：直接合成新增 hunk，不走 libgit2 的 diff
    if matches!(area, StageArea::Untracked) {
        return synthesize_untracked_diff(repo, &normalized);
    }

    let mut opts = DiffOptions::new();
    opts.pathspec(&normalized).include_typechange(true);

    let mut diff = match area {
        StageArea::Staged => {
            let tree = head_tree(repo);
            repo.diff_tree_to_index(tree.as_ref(), Some(&index), Some(&mut opts))?
        }
        _ => repo.diff_index_to_workdir(Some(&index), Some(&mut opts))?,
    };

    let raw_text = collect_patch_text(&mut diff);
    let mut patches = parse_patch(&raw_text);
    let raw = if patches.is_empty() {
        None
    } else {
        Some(patches.remove(0))
    };

    let mut diff_meta: Option<FileDiff> = None;
    for delta in diff.deltas() {
        let Some(file) = delta_to_changed_file(&delta, area, None) else {
            continue;
        };
        diff_meta = Some(FileDiff {
            path: file.path,
            old_path: file.old_path,
            status: file.status,
            area,
            binary: file.binary,
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
            truncated: false,
        });
        break;
    }

    let mut meta = match diff_meta {
        Some(m) => m,
        None => FileDiff {
            path: normalized,
            old_path: None,
            status: FileStatus::Modified,
            area,
            binary: false,
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
            truncated: false,
        },
    };

    if meta.binary || raw_text.is_empty() {
        return Ok((meta, raw));
    }

    if let Some(raw_patch) = raw.as_ref() {
        let total_hunks = raw_patch.hunks.len();
        for (i, hunk) in raw_patch.hunks.iter().enumerate() {
            if i >= total_hunks {
                break;
            }
            let (old_start, old_lines, new_start, new_lines, _heading) =
                parse_hunk_header(&hunk.header);

            let lines = parse_hunk_lines(&hunk.body, old_start, new_start);

            let additions = lines
                .iter()
                .filter(|l| l.kind == HunkLineKind::Addition)
                .count() as u32;
            let deletions = lines
                .iter()
                .filter(|l| l.kind == HunkLineKind::Deletion)
                .count() as u32;

            meta.additions += additions;
            meta.deletions += deletions;
            meta.hunks.push(Hunk {
                index: i,
                header: hunk.header.trim_end_matches(['\n', '\r']).to_string(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines,
                additions,
                deletions,
            });
        }
    }

    Ok((meta, raw))
}

/// 读取单文件 diff 供前端展示。
pub fn read_file_diff(repo: &Repository, path: &str, area: StageArea) -> AppResult<FileDiff> {
    let (diff, _raw) = file_diff_raw(repo, path, area)?;
    Ok(diff)
}

/// 读取工作区单文件的完整前后内容（FilePair），供统一的 SideBySideDiff 组件渲染。
pub fn read_workdir_file_pair(
    repo: &Repository,
    path: &str,
    area: StageArea,
) -> AppResult<FilePair> {
    let (diff, _) = file_diff_raw(repo, path, area)?;

    let old_path_str = diff.old_path.as_deref().unwrap_or(&diff.path);
    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::State("bare repository has no working directory".into()))?;

    let (old_blob, old_exists) = match area {
        StageArea::Untracked => (None, false),
        StageArea::Unstaged => {
            let index = fresh_index(repo)?;
            let entry = index.get_path(Path::new(old_path_str), 0);
            let blob = entry.and_then(|e| repo.find_blob(e.id).ok());
            let exists = blob.is_some();
            (blob, exists)
        }
        StageArea::Staged => {
            let tree = head_tree(repo);
            let blob = tree.as_ref().and_then(|t| {
                let entry = t.get_path(Path::new(old_path_str)).ok()?;
                if entry.kind() == Some(git2::ObjectType::Blob) {
                    repo.find_blob(entry.id()).ok()
                } else {
                    None
                }
            });
            let exists = blob.is_some();
            (blob, exists)
        }
    };

    let mut new_disk_bytes: Option<Vec<u8>> = None;
    let mut new_index_blob: Option<git2::Blob<'_>> = None;
    let new_exists = match area {
        StageArea::Untracked | StageArea::Unstaged => {
            if diff.status == FileStatus::Deleted {
                false
            } else {
                let abs = workdir.join(&diff.path);
                if abs.exists() {
                    new_disk_bytes = std::fs::read(&abs).ok();
                    new_disk_bytes.is_some()
                } else {
                    false
                }
            }
        }
        StageArea::Staged => {
            if diff.status == FileStatus::Deleted {
                false
            } else {
                let index = fresh_index(repo)?;
                let entry = index.get_path(Path::new(&diff.path), 0);
                new_index_blob = entry.and_then(|e| repo.find_blob(e.id).ok());
                new_index_blob.is_some()
            }
        }
    };

    let old_size = old_blob.as_ref().map(|b| b.size()).unwrap_or(0);
    let new_size = match area {
        StageArea::Untracked | StageArea::Unstaged => {
            new_disk_bytes.as_ref().map(|b| b.len()).unwrap_or(0)
        }
        StageArea::Staged => new_index_blob.as_ref().map(|b| b.size()).unwrap_or(0),
    };

    let too_big = old_size > crate::model::MAX_PREVIEW_BYTES
        || new_size > crate::model::MAX_PREVIEW_BYTES;

    let binary = diff.binary
        || old_blob.as_ref().map(|b| b.is_binary()).unwrap_or(false)
        || match area {
            StageArea::Untracked | StageArea::Unstaged => new_disk_bytes
                .as_ref()
                .map(|b| b.iter().take(8000).any(|&x| x == 0))
                .unwrap_or(false),
            StageArea::Staged => new_index_blob
                .as_ref()
                .map(|b| b.is_binary())
                .unwrap_or(false),
        };

    let (old_content, new_content) = if binary || too_big {
        (String::new(), String::new())
    } else {
        let oc = old_blob
            .as_ref()
            .map(|b| String::from_utf8_lossy(b.content()).to_string())
            .unwrap_or_default();
        let nc = match area {
            StageArea::Untracked | StageArea::Unstaged => new_disk_bytes
                .as_ref()
                .map(|b| String::from_utf8_lossy(&b).to_string())
                .unwrap_or_default(),
            StageArea::Staged => new_index_blob
                .as_ref()
                .map(|b| String::from_utf8_lossy(b.content()).to_string())
                .unwrap_or_default(),
        };
        (oc, nc)
    };

    Ok(FilePair {
        path: diff.path,
        old_path: diff.old_path,
        status: diff.status,
        old_content,
        new_content,
        old_exists,
        new_exists,
        binary,
        truncated: too_big,
        hunks: diff.hunks,
        additions: diff.additions,
        deletions: diff.deletions,
    })
}

/// 读取任意两棵树之间单文件的 diff（用于查看历史提交里的某个文件）。
///
/// 这是历史视图复用的入口：与工作区 diff 使用同一套 hunk 数据结构，
/// 因此前端可以共用 `DiffViewer`，无需第二套渲染逻辑。
pub fn read_tree_diff_file(
    repo: &Repository,
    old_tree: Option<&git2::Tree<'_>>,
    new_tree: &git2::Tree<'_>,
    path: &str,
) -> AppResult<FileDiff> {
    let normalized = path.replace('\\', "/");

    let mut opts = DiffOptions::new();
    opts.pathspec(&normalized).include_typechange(true);

    let mut diff = repo.diff_tree_to_tree(old_tree, Some(new_tree), Some(&mut opts))?;

    let mut find = similar_opts();
    let _ = diff.find_similar(Some(&mut find));

    let raw_text = collect_patch_text(&mut diff);

    let mut patches = parse_patch(&raw_text);
    let raw = if patches.is_empty() {
        None
    } else {
        Some(patches.remove(0))
    };

    // 元信息
    let mut meta = FileDiff {
        path: normalized.clone(),
        old_path: None,
        status: FileStatus::Modified,
        area: StageArea::Staged,
        binary: false,
        hunks: Vec::new(),
        additions: 0,
        deletions: 0,
        truncated: false,
    };

    for delta in diff.deltas() {
        if let Some(file) = delta_to_changed_file(&delta, StageArea::Staged, None) {
            meta.path = file.path;
            meta.old_path = file.old_path;
            meta.status = file.status;
            meta.binary = file.binary;
            break;
        }
    }

    if meta.binary || raw_text.is_empty() {
        return Ok(meta);
    }

    if let Some(raw_patch) = raw {
        for (i, hunk) in raw_patch.hunks.iter().enumerate() {
            let (old_start, old_lines, new_start, new_lines, _h) = parse_hunk_header(&hunk.header);
            let lines = parse_hunk_lines(&hunk.body, old_start, new_start);

            let additions = lines
                .iter()
                .filter(|l| l.kind == HunkLineKind::Addition)
                .count() as u32;
            let deletions = lines
                .iter()
                .filter(|l| l.kind == HunkLineKind::Deletion)
                .count() as u32;

            meta.additions += additions;
            meta.deletions += deletions;
            meta.hunks.push(Hunk {
                index: i,
                header: hunk.header.trim_end_matches(['\n', '\r']).to_string(),
                old_start,
                old_lines,
                new_start,
                new_lines,
                lines,
                additions,
                deletions,
            });
        }
    }

    Ok(meta)
}

// ---------------------------------------------------------------------------
// patch 文本收集 与 未跟踪文件合成
// ---------------------------------------------------------------------------

/// 把 `Diff` 渲染成标准 patch 文本。
///
/// `line.content()` 只给出正文，`origin()`（+/-/空格/H/F）是独立的前缀字符，
/// 必须自己补回，否则重建出的 patch 无法被 `git apply` 识别。
fn collect_patch_text(diff: &mut Diff<'_>) -> String {
    let mut raw: Vec<u8> = Vec::new();
    match diff.print(DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        // 'F' = 文件级元信息行（diff --git / index / --- / +++），'H' = hunk 头，
        // 这两类 git2 已经给出带前缀的完整行。
        if origin == 'F' || origin == 'H' {
            raw.extend_from_slice(line.content());
        } else {
            raw.push(origin as u8);
            raw.extend_from_slice(line.content());
        }
        true
    }) {
        Ok(()) => String::from_utf8_lossy(&raw).to_string(),
        Err(_) => String::new(),
    }
}

/// 为未跟踪文件合成「整个文件都是新增」的 diff。
///
/// libgit2 对未跟踪文件只给空 delta，所以这里自行构造 hunk 与 patch 头，
/// 让未跟踪文件也能获得与已跟踪文件一致的 hunk 级操作体验（例如丢弃）。
fn synthesize_untracked_diff(
    repo: &Repository,
    normalized: &str,
) -> AppResult<(FileDiff, Option<RawFilePatch>)> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let abs = workdir.join(normalized);
    let bytes = std::fs::read(&abs)?;

    // 含 NUL 字节视为二进制
    let binary = bytes.iter().take(8000).any(|&b| b == 0);
    if binary {
        let meta = FileDiff {
            path: normalized.to_string(),
            old_path: None,
            status: FileStatus::Untracked,
            area: StageArea::Untracked,
            binary: true,
            hunks: Vec::new(),
            additions: 0,
            deletions: 0,
            truncated: false,
        };
        return Ok((meta, None));
    }

    let text = String::from_utf8_lossy(&bytes).to_string();
    let has_trailing_newline = text.ends_with('\n');
    let mut contents: Vec<&str> = text.split('\n').collect();
    if has_trailing_newline {
        contents.pop(); // 末尾空串不算一行
    }

    let total = contents.len() as u32;
    let lines: Vec<HunkLine> = contents
        .iter()
        .enumerate()
        .map(|(i, c)| HunkLine {
            kind: HunkLineKind::Addition,
            content: (*c).to_string(),
            old_lineno: None,
            new_lineno: Some(i as u32 + 1),
            no_newline: !has_trailing_newline && i as u32 + 1 == total,
        })
        .collect();

    let header = format!("@@ -0,0 +1,{total} @@");
    let hunk = Hunk {
        index: 0,
        header: header.clone(),
        old_start: 0,
        old_lines: 0,
        new_start: 1,
        new_lines: total,
        lines,
        additions: total,
        deletions: 0,
    };

    // 合成可被 git apply 接受的「全新文件」patch
    let mut body = String::new();
    for c in &contents {
        body.push('+');
        body.push_str(c);
        body.push('\n');
    }
    let patch_header = format!(
        "diff --git a/{p} b/{p}\nnew file mode 100644\nindex 0000000..0000000\n--- /dev/null\n+++ b/{p}\n",
        p = normalized
    );
    let raw = RawFilePatch {
        header: patch_header,
        hunks: vec![RawHunk {
            header: format!("{header}\n"),
            body,
        }],
    };

    let meta = FileDiff {
        path: normalized.to_string(),
        old_path: None,
        status: FileStatus::Untracked,
        area: StageArea::Untracked,
        binary: false,
        additions: total,
        hunks: vec![hunk],
        deletions: 0,
        truncated: false,
    };

    Ok((meta, Some(raw)))
}

// ---------------------------------------------------------------------------
// 文件级操作
// ---------------------------------------------------------------------------

pub fn stage_file(repo: &Repository, path: &str) -> AppResult<()> {
    let mut index = fresh_index(repo)?;
    let normalized = path.replace('\\', "/");
    let p = Path::new(&normalized);
    index.add_path(p)?;
    index.write()?;
    Ok(())
}

pub fn unstage_file(repo: &Repository, path: &str) -> AppResult<()> {
    let normalized = path.replace('\\', "/");
    match repo.head() {
        Ok(head) => {
            let obj = head.peel(git2::ObjectType::Commit)?;
            repo.reset_default(Some(&obj), &[normalized.as_str()])?;
        }
        Err(_) => {
            // 尚无提交：直接从索引移除
            let mut index = fresh_index(repo)?;
            index.remove_path(Path::new(&normalized))?;
            index.write()?;
        }
    }
    Ok(())
}

pub fn discard_file(repo: &Repository, path: &str, area: StageArea) -> AppResult<()> {
    let normalized = path.replace('\\', "/");
    match area {
        StageArea::Untracked => {
            let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
            let abs = workdir.join(&normalized);
            if abs.exists() {
                std::fs::remove_file(&abs)?;
            }
        }
        _ => {
            // 用 checkout_head 从 HEAD 内容还原，能正确处理行尾与文件模式
            let mut checkout = git2::build::CheckoutBuilder::new();
            checkout.path(&normalized).force();
            repo.checkout_head(Some(&mut checkout))?;

            // 若存在 HEAD，同时重置索引中的对应文件，确保冲突索引（stages 1/2/3）被彻底清除
            if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
                let _ = repo.reset_default(Some(head.as_object()), &[&normalized]);
            }
        }
    }
    Ok(())
}

pub fn stage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let mut index = fresh_index(repo)?;
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    for path in paths {
        let normalized = path.replace('\\', "/");
        let p = Path::new(&normalized);
        let abs = workdir.join(p);
        if abs.exists() {
            if abs.is_dir() {
                let _ = index.add_all([&normalized], git2::IndexAddOption::DEFAULT, None);
            } else {
                let _ = index.add_path(p);
            }
        } else {
            let _ = index.remove_path(p);
        }
    }
    index.write()?;
    Ok(())
}

pub fn unstage_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let normalized: Vec<String> = paths.iter().map(|p| p.replace('\\', "/")).collect();
    let path_slices: Vec<&str> = normalized.iter().map(|s| s.as_str()).collect();
    match repo.head() {
        Ok(head) => {
            let obj = head.peel(git2::ObjectType::Commit)?;
            repo.reset_default(Some(&obj), &path_slices)?;
        }
        Err(_) => {
            let mut index = fresh_index(repo)?;
            for p in &normalized {
                let _ = index.remove_path(Path::new(p));
            }
            index.write()?;
        }
    }
    Ok(())
}

pub fn discard_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let normalized: Vec<String> = paths.iter().map(|p| p.replace('\\', "/")).collect();
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.force();
    for p in &normalized {
        checkout.path(p);
    }
    repo.checkout_head(Some(&mut checkout))?;
    if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
        let path_slices: Vec<&str> = normalized.iter().map(|s| s.as_str()).collect();
        let _ = repo.reset_default(Some(head.as_object()), &path_slices);
    }
    Ok(())
}

pub fn clean_untracked_paths(repo: &Repository, paths: &[String]) -> AppResult<()> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    for path in paths {
        let normalized = path.replace('\\', "/");
        let abs = workdir.join(&normalized);
        if abs.exists() {
            if abs.is_dir() {
                let _ = std::fs::remove_dir_all(&abs);
            } else {
                let _ = std::fs::remove_file(&abs);
            }
        }
    }
    Ok(())
}

pub fn add_to_gitignore(repo: &Repository, pattern: &str) -> AppResult<()> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let gitignore_path = workdir.join(".gitignore");
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&gitignore_path)?;
    if gitignore_path.exists() {
        if let Ok(meta) = file.metadata() {
            if meta.len() > 0 {
                let content = std::fs::read_to_string(&gitignore_path).unwrap_or_default();
                if !content.ends_with('\n') {
                    writeln!(file)?;
                }
            }
        }
    }
    writeln!(file, "{}", pattern.trim())?;
    Ok(())
}

// ---------------------------------------------------------------------------
// hunk 级操作
// ---------------------------------------------------------------------------

fn git_apply_patch(repo: &Repository, patch_text: &str, cached: bool, reverse: bool) -> AppResult<()> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let tmp = temp_patch_path();
    std::fs::write(&tmp, patch_text.as_bytes())?;

    let mut cmd = Command::new("git");
    cmd.current_dir(workdir)
        .arg("apply")
        .arg("--whitespace=nowarn")
        .arg("--recount");

    if cached {
        cmd.arg("--cached");
    }
    if reverse {
        cmd.arg("--reverse");
    }
    cmd.arg(&tmp);

    let output = cmd.output();

    // 无论成功失败都清理临时文件
    let _ = std::fs::remove_file(&tmp);

    match output {
        Ok(out) if out.status.success() => Ok(()),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            Err(AppError::State(format!("git apply failed: {stderr}")))
        }
        Err(e) => Err(AppError::Io(e)),
    }
}

fn temp_patch_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    p.push(format!("git-hunk-{nanos}-{}.patch", std::process::id()));
    p
}

/// 暂存单个 hunk：把 index→workdir 的补丁中第 `hunk_index` 块应用到索引。
pub fn stage_hunk(repo: &Repository, path: &str, hunk_index: usize) -> AppResult<()> {
    let (_diff, raw) = file_diff_raw(repo, path, StageArea::Unstaged)?;
    let raw = raw.ok_or_else(|| AppError::State(format!("no diff for {path}")))?;
    if raw.is_rename() {
        return Err(AppError::State(
            "renamed files must be staged as a whole".to_string(),
        ));
    }
    let patch = raw.build(hunk_index)?;
    git_apply_patch(repo, &patch, true, false)
}

/// 取消暂存单个 hunk：把 HEAD→index 的补丁中第 `hunk_index` 块反向应用到索引。
pub fn unstage_hunk(repo: &Repository, path: &str, hunk_index: usize) -> AppResult<()> {
    let (_diff, raw) = file_diff_raw(repo, path, StageArea::Staged)?;
    let raw = raw.ok_or_else(|| AppError::State(format!("no staged diff for {path}")))?;
    if raw.is_rename() {
        return Err(AppError::State(
            "renamed files must be unstaged as a whole".to_string(),
        ));
    }
    let patch = raw.build(hunk_index)?;
    git_apply_patch(repo, &patch, true, true)
}

/// 丢弃单个 hunk：把 index→workdir 的补丁中第 `hunk_index` 块反向应用到工作区。
pub fn discard_hunk(repo: &Repository, path: &str, hunk_index: usize) -> AppResult<()> {
    let (_diff, raw) = file_diff_raw(repo, path, StageArea::Unstaged)?;
    let raw = raw.ok_or_else(|| AppError::State(format!("no diff for {path}")))?;
    if raw.is_rename() {
        return Err(AppError::State(
            "renamed files must be discarded as a whole".to_string(),
        ));
    }
    let patch = raw.build(hunk_index)?;
    git_apply_patch(repo, &patch, false, true)
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

pub fn commit(repo: &Repository, message: &str) -> AppResult<CommitResult> {
    if message.trim().is_empty() {
        return Err(AppError::State("commit message must not be empty".into()));
    }

    let mut index = fresh_index(repo)?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let sig = repo.signature()?;

    let parent_obj = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
    let parents: Vec<&git2::Commit<'_>> = parent_obj.iter().collect();

    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    let commit = repo.find_commit(oid)?;
    let short = commit
        .as_object()
        .short_id()
        .map(|b| b.as_str().unwrap_or("").to_string())
        .unwrap_or_else(|_| oid.to_string().chars().take(7).collect());

    Ok(CommitResult {
        oid: oid.to_string(),
        short_oid: short,
        summary: commit.summary().unwrap_or("").to_string(),
    })
}

/// amend：用当前索引重写 HEAD 提交，保留原父提交。
pub fn amend(repo: &Repository, message: &str) -> AppResult<CommitResult> {
    if message.trim().is_empty() {
        return Err(AppError::State("commit message must not be empty".into()));
    }

    let mut index = fresh_index(repo)?;
    let tree_oid = index.write_tree()?;
    let tree = repo.find_tree(tree_oid)?;
    let sig = repo.signature()?;

    let head_commit = repo.head()?.peel_to_commit()?;
    // `parents()` 产出的是拥有所有权的 `Commit`，需要持有再用引用传入
    let parent_commits: Vec<git2::Commit<'_>> = head_commit.parents().collect();
    let parents: Vec<&git2::Commit<'_>> = parent_commits.iter().collect();

    // 注意：amend 不能用 `commit(Some("HEAD"), ...)`，因为 libgit2 会校验
    // 「当前 tip 必须是第一个父提交」，而 amend 时第一个父提交是祖父提交。
    // 正确做法是先创建游离提交，再显式把 HEAD（或它指向的分支）移动过去。
    let oid = repo.commit(None, &sig, &sig, message, &tree, &parents)?;
    let head_ref = repo.head()?;
    let refname = head_ref
        .name()
        .map(|s| s.to_string())
        .unwrap_or_else(|| "HEAD".to_string());
    drop(head_ref);
    repo.reference(&refname, oid, true, "commit (amend)")?;
    let commit = repo.find_commit(oid)?;
    let short = commit
        .as_object()
        .short_id()
        .map(|b| b.as_str().unwrap_or("").to_string())
        .unwrap_or_else(|_| oid.to_string().chars().take(7).collect());

    Ok(CommitResult {
        oid: oid.to_string(),
        short_oid: short,
        summary: commit.summary().unwrap_or("").to_string(),
    })
}

/// 打开仓库；传入的可能是仓库子目录，会自动向上发现。
pub fn open(path: &str) -> AppResult<Repository> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(AppError::InvalidPath(path.to_string()));
    }
    Ok(Repository::open(p)?)
}

/// 在给定目录下发现仓库（支持子目录）。
pub fn discover(path: &str) -> AppResult<Repository> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(AppError::InvalidPath(path.to_string()));
    }
    Ok(Repository::discover(p)?)
}

/// 允许未来扩展：初始化仓库，M0 暂未暴露给前端。
#[allow(dead_code)]
pub fn init(path: &str) -> AppResult<Repository> {
    let repo = Repository::init(path)?;
    Ok(repo)
}

/// 批量暂存（保留给后续“暂存全部”使用）。
#[allow(dead_code)]
pub fn stage_all(repo: &Repository) -> AppResult<()> {
    let mut index = repo.index()?;
    index.add_all(["*"].iter(), IndexAddOption::DEFAULT, None)?;
    index.write()?;
    Ok(())
}

/// 供调试：把写入临时文件的 patch 落下，便于排查。
#[allow(dead_code)]
pub fn debug_dump_patch(text: &str) -> AppResult<PathBuf> {
    let p = temp_patch_path();
    let mut f = std::fs::File::create(&p)?;
    f.write_all(text.as_bytes())?;
    Ok(p)
}
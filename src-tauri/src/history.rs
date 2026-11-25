//! 提交历史与 DAG 泳道计算。
//!
//! 这是「提交关系图」的核心。算法与渲染解耦：本模块只产出数据结构
//! （每个 commit 的 `lane`、`passing_lanes`、`merge_lanes`），前端负责画线。
//!
//! ## 泳道算法
//!
//! 目标：给定按拓扑序（子在前、父在后）排列的提交序列，为每行分配一条泳道，
//! 并算出「本行到下一行之间有哪几条泳道在穿行」，前端据此画竖向连线。
//!
//! 维护 `active: Vec<Option<String>>`，`active[i]` 表示第 i 条泳道当前「期待
//! 出现」的提交 oid。逐行处理：
//!
//! 1. 若当前 commit 的 oid 出现在某个活跃泳道 → 它就是该泳道的延续，沿用该泳道号；
//!    否则分配一条空闲泳道（优先复用空位，保持图紧凑）。
//! 2. 该 commit 的第一个父提交接管当前泳道（保证主线连续）。
//! 3. 其余父提交（合并提交）各占一条新泳道 → 记录进 `merge_lanes`（分叉）。
//! 4. 处理完后，`active` 中仍指向某个 oid 的泳道即为「穿行」泳道。
//!
//! 特殊情况：
//! - **根提交**（无父）：该泳道在此终结，置空。
//! - **同一父提交被多个子提交引用**（合并后再分叉）：让先遇到的子提交接管，
//!   后续子提交不再重复分配泳道，避免线条重复。

use git2::{Oid, Repository, Sort};
use std::collections::HashMap;

use crate::error::{AppError, AppResult};
use crate::model::{
    CommitDetail, CommitPage, CommitRef, FilePair, FileStatus, GraphCommit, RefKind,
    MAX_PREVIEW_BYTES,
};

/// 泳道算法所需的最小输入：oid 与它的父提交列表。
#[derive(Debug, Clone)]
pub struct CommitNode {
    pub oid: String,
    pub parents: Vec<String>,
}

/// 泳道算法的输出。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaneAssignment {
    /// 本提交所在泳道。
    pub lane: u32,
    /// 本行向下连接的线段集合。
    pub segments: Vec<crate::model::LaneSegment>,
    /// 本提交分叉出的额外泳道。
    pub merge_lanes: Vec<u32>,
}

/// 纯算法入口：给定拓扑序的提交节点，计算每一行的泳道与连线。
///
/// 不依赖 git 仓库，便于用单元测试把算法行为钉死。
///
/// ## 语义
///
/// `active[i] = Some(oid)` 表示「第 i 条泳道正在等待 `oid` 出现」。
/// 关键不变式：**同一个 oid 至多占据一条泳道**。多个子提交指向同一父提交时，
/// 只有最早的那个会把父提交登记到自己的泳道，后来的子提交直接连过去（画斜线），
/// 否则同一父提交会占多条泳道，图就会错乱。
///
/// 分配父提交泳道时，若该父提交已被登记，绝不覆盖。
pub fn assign_lanes(nodes: &[CommitNode]) -> Vec<LaneAssignment> {
    // active[i] = 第 i 条泳道正在等待的提交 oid
    let mut active: Vec<Option<String>> = Vec::new();
    let mut out: Vec<LaneAssignment> = Vec::with_capacity(nodes.len());

    // 找到一条可用泳道，`avoid` 为本行独占、不可复用的泳道。
    let alloc_lane = |active: &mut Vec<Option<String>>, avoid: Option<u32>| -> u32 {
        match active
            .iter()
            .enumerate()
            .position(|(i, s)| s.is_none() && Some(i as u32) != avoid)
        {
            Some(i) => i as u32,
            None => {
                active.push(None);
                (active.len() - 1) as u32
            }
        }
    };

    for node in nodes {
        // 所有正在等待本提交的泳道（汇合时可能多条）
        let waiting: Vec<u32> = active
            .iter()
            .enumerate()
            .filter(|(_, s)| s.as_deref() == Some(node.oid.as_str()))
            .map(|(i, _)| i as u32)
            .collect();

        // 本行泳道：沿用最早等待它的那条；无人等待则新分配
        let lane = match waiting.first() {
            Some(l) => *l,
            None => alloc_lane(&mut active, None),
        };

        // 其余等待者到此终结（它们会在本行画出汇合斜线）
        for other in waiting.iter().skip(1) {
            active[*other as usize] = None;
        }

        // 本泳道先清空，随后交给父提交；本行后续分配必须避开它
        active[lane as usize] = None;

        let mut segments: Vec<crate::model::LaneSegment> = Vec::new();

        // 汇合斜线：从被终结的泳道连到本泳道
        for other in waiting.iter().skip(1) {
            segments.push(crate::model::LaneSegment {
                from_lane: *other,
                to_lane: lane,
            });
        }

        // 处理父提交。
        //
        // 第一父提交**总是**占用本行泳道，即使该父提交已被别的泳道登记。
        // 原因：h2、h3 这类兄弟提交都指向同一父提交 base 时，它们各自的泳道
        // 必须保持「等待 base」的状态直到 base 真正的行出现，届时再汇合。
        // 若因为 base 已登记就提前释放本泳道，该泳道会被后续兄弟提交复用，
        // 导致两条本应平行的分支挤在同一条泳道上。
        let mut merge_lanes: Vec<u32> = Vec::new();
        let mut sibling_lanes: Vec<u32> = Vec::new();
        for (idx, parent) in node.parents.iter().enumerate() {
            if idx == 0 {
                // 记录「除本行泳道外，还有哪些泳道也在等这个父提交」，
                // 父提交行出现时要把它们连过来（汇合）。
                sibling_lanes = active
                    .iter()
                    .enumerate()
                    .filter(|(i, s)| {
                        *i as u32 != lane && s.as_deref() == Some(parent.as_str())
                    })
                    .map(|(i, _)| i as u32)
                    .collect();

                active[lane as usize] = Some(parent.clone());
                segments.push(crate::model::LaneSegment {
                    from_lane: lane,
                    to_lane: lane,
                });
                continue;
            }

            // 其余父提交（合并提交）若已被登记则直接连过去，不再分叉
            let existing = active
                .iter()
                .enumerate()
                .find(|(_, s)| s.as_deref() == Some(parent.as_str()))
                .map(|(i, _)| i as u32);

            let parent_lane = match existing {
                Some(l) => l,
                None => {
                    let l = alloc_lane(&mut active, Some(lane));
                    active[l as usize] = Some(parent.clone());
                    merge_lanes.push(l);
                    l
                }
            };

            segments.push(crate::model::LaneSegment {
                from_lane: lane,
                to_lane: parent_lane,
            });
        }

        // 本提交的父提交若已被兄弟泳道等待，本行也要画一条指向兄弟泳道的线，
        // 否则两条竖直平行线会看起来互不相连。
        for s in &sibling_lanes {
            // 已在上面处理过的汇合段不重复添加
            if !segments
                .iter()
                .any(|seg| seg.from_lane == lane && seg.to_lane == *s)
            {
                // 兄弟泳道指向本泳道（汇合），方向统一为「从外侧到本泳道」
                segments.push(crate::model::LaneSegment {
                    from_lane: *s,
                    to_lane: lane,
                });
            }
        }

        // 其余仍在穿行的泳道：竖直穿过本行
        for (i, s) in active.iter().enumerate() {
            let i = i as u32;
            if s.is_some() && i != lane && !segments.iter().any(|seg| seg.from_lane == i && seg.to_lane == i) {
                // 只有本来就在穿行的泳道才需要竖线；刚分配的父泳道已在上面处理
                let is_new_parent_lane = merge_lanes.contains(&i);
                if !is_new_parent_lane {
                    segments.push(crate::model::LaneSegment {
                        from_lane: i,
                        to_lane: i,
                    });
                }
            }
        }

        // 去重并排序，保证输出稳定
        segments.sort();
        segments.dedup();

        out.push(LaneAssignment {
            lane,
            segments,
            merge_lanes,
        });

        // 收缩尾部空泳道
        while matches!(active.last(), Some(None)) {
            active.pop();
        }
    }

    out
}

/// 构造单行提交节点输出（供普通 DAG 分页与全历史筛选分页共用）。
#[allow(clippy::too_many_arguments)]
fn build_graph_commit(
    commit: &git2::Commit<'_>,
    oid_str: String,
    parents: Vec<String>,
    lane: u32,
    segments: Vec<crate::model::LaneSegment>,
    merge_lanes: Vec<u32>,
    ref_map: &HashMap<String, Vec<CommitRef>>,
    head_oid: Option<&str>,
) -> GraphCommit {
    let short = commit
        .as_object()
        .short_id()
        .map(|b| b.as_str().unwrap_or("").to_string())
        .unwrap_or_else(|_| oid_str.chars().take(7).collect());

    let refs = ref_map.get(&oid_str).cloned().unwrap_or_default();
    let is_head = head_oid == Some(oid_str.as_str());

    GraphCommit {
        oid: oid_str,
        short_oid: short,
        summary: commit.summary().unwrap_or("").to_string(),
        author_name: commit
            .author()
            .name()
            .unwrap_or("(unknown)")
            .to_string(),
        author_email: commit
            .author()
            .email()
            .unwrap_or("")
            .to_string(),
        timestamp: commit.time().seconds(),
        parents,
        lane,
        segments,
        merge_lanes,
        refs,
        is_head,
    }
}

/// 判定提交是否命中关键词（大小写不敏感：支持完整/短 SHA、提交标题与正文、作者名/邮箱、分支与标签引用）。
fn commit_matches_query(
    commit: &git2::Commit<'_>,
    oid_str: &str,
    refs: &[CommitRef],
    q_lower: &str,
) -> bool {
    if oid_str.contains(q_lower) {
        return true;
    }
    if let Some(msg) = commit.message() {
        if msg.to_lowercase().contains(q_lower) {
            return true;
        }
    } else if let Some(summary) = commit.summary() {
        if summary.to_lowercase().contains(q_lower) {
            return true;
        }
    }
    let author = commit.author();
    if let Some(name) = author.name() {
        if name.to_lowercase().contains(q_lower) {
            return true;
        }
    }
    if let Some(email) = author.email() {
        if email.to_lowercase().contains(q_lower) {
            return true;
        }
    }
    refs.iter().any(|r| r.name.to_lowercase().contains(q_lower))
}

/// 读取提交历史（分页 + 可选分支范围与关键词全历史过滤）。
///
/// - `limit`：本页最多返回多少条
/// - `skip`：跳过多少条（滚动加载时分页）
/// - `branch`：过滤分支范围：`None` 或 `"HEAD"` 表示当前分支；`"__ALL__"` 表示所有本地与远程分支；其余视为具体分支名
/// - `query`：筛选关键词；非空时流式扫描分支范围内的全部历史并在匹配 `skip + limit + 1` 条后提前返回分页结果（单列紧凑时间线，避免孤立父节点炸裂泳道）
///
/// 使用 `Sort::TOPOLOGICAL | Sort::TIME`：拓扑序保证「子一定在父之前」，
/// 这是泳道算法的前提；TIME 作为同一拓扑层的次级排序，让图更符合直觉。
#[cfg_attr(not(test), allow(dead_code))]
pub fn read_history(
    repo: &Repository,
    limit: usize,
    skip: usize,
    branch: Option<&str>,
    query: Option<&str>,
) -> AppResult<CommitPage> {
    read_history_cancellable(repo, limit, skip, branch, query, || false)
}

/// 读取提交历史（支持外部分支取消回调，当用户继续输入筛选词或切换分支时提前终止旧 revwalk）。
pub fn read_history_cancellable<F>(
    repo: &Repository,
    limit: usize,
    skip: usize,
    branch: Option<&str>,
    query: Option<&str>,
    mut should_cancel: F,
) -> AppResult<CommitPage>
where
    F: FnMut() -> bool,
{
    if limit == 0 {
        return Ok(CommitPage {
            lane_count: 1,
            has_more: false,
            commits: Vec::new(),
        });
    }

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    match branch.map(str::trim).filter(|s| !s.is_empty()) {
        None | Some("HEAD") => {
            if walk.push_head().is_err() {
                return Ok(CommitPage {
                    lane_count: 1,
                    has_more: false,
                    commits: Vec::new(),
                });
            }
        }
        Some("__ALL__") => {
            let _ = walk.push_glob("refs/heads/*");
            let _ = walk.push_glob("refs/remotes/*");
            let _ = walk.push_head();
        }
        Some(target) => {
            let obj = repo
                .revparse_single(target)
                .or_else(|_| repo.revparse_single(&format!("refs/heads/{target}")))
                .or_else(|_| repo.revparse_single(&format!("refs/remotes/{target}")))?;
            let commit = obj.peel_to_commit()?;
            walk.push(commit.id())?;
        }
    }

    // 引用装饰：一次性建好 oid -> refs 映射
    let ref_map = build_ref_map(repo)?;

    let head_oid = repo
        .head()
        .ok()
        .and_then(|h| h.target())
        .map(|o| o.to_string());

    if let Some(q_lower) = query
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase)
    {
        let mut matched_idx = 0usize;
        let mut has_more = false;
        let mut commits = Vec::with_capacity(limit.min(256));

        for (step, oid_res) in walk.enumerate() {
            if step % 128 == 0 && should_cancel() {
                return Ok(CommitPage {
                    lane_count: 1,
                    has_more: false,
                    commits: Vec::new(),
                });
            }
            let Ok(oid) = oid_res else {
                continue;
            };
            let commit = repo.find_commit(oid)?;
            let oid_str = oid.to_string();
            let refs = ref_map.get(&oid_str).map(Vec::as_slice).unwrap_or(&[]);
            if !commit_matches_query(&commit, &oid_str, refs, &q_lower) {
                continue;
            }
            if matched_idx < skip {
                matched_idx += 1;
                continue;
            }
            if commits.len() >= limit {
                has_more = true;
                break;
            }
            let parents = commit.parent_ids().map(|p| p.to_string()).collect();
            commits.push(build_graph_commit(
                &commit,
                oid_str,
                parents,
                0,
                Vec::new(),
                Vec::new(),
                &ref_map,
                head_oid.as_deref(),
            ));
            matched_idx += 1;
        }

        return Ok(CommitPage {
            lane_count: 1,
            has_more,
            commits,
        });
    }

    // 未过滤模式：取出全部 oid 并对当前页计算完整 DAG 泳道
    let mut all_oids: Vec<Oid> = Vec::new();
    for (step, oid_res) in walk.enumerate() {
        if step % 256 == 0 && should_cancel() {
            return Ok(CommitPage {
                lane_count: 1,
                has_more: false,
                commits: Vec::new(),
            });
        }
        if let Ok(oid) = oid_res {
            all_oids.push(oid);
        }
    }
    let total = all_oids.len();
    let end = (skip + limit).min(total);
    let slice = if skip >= total {
        &all_oids[0..0]
    } else {
        &all_oids[skip..end]
    };

    // 构建节点序列
    let mut nodes: Vec<CommitNode> = Vec::with_capacity(slice.len());
    for oid in slice {
        let commit = repo.find_commit(*oid)?;
        nodes.push(CommitNode {
            oid: oid.to_string(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        });
    }

    // 计算泳道
    let lanes = assign_lanes(&nodes);

    let mut commits: Vec<GraphCommit> = Vec::with_capacity(nodes.len());
    let mut max_lane = 0u32;

    for (i, oid) in slice.iter().enumerate() {
        let commit = repo.find_commit(*oid)?;
        let oid_str = oid.to_string();
        let assignment = &lanes[i];

        max_lane = max_lane.max(assignment.lane);
        for seg in &assignment.segments {
            max_lane = max_lane.max(seg.from_lane).max(seg.to_lane);
        }
        for l in &assignment.merge_lanes {
            max_lane = max_lane.max(*l);
        }

        commits.push(build_graph_commit(
            &commit,
            oid_str,
            nodes[i].parents.clone(),
            assignment.lane,
            assignment.segments.clone(),
            assignment.merge_lanes.clone(),
            &ref_map,
            head_oid.as_deref(),
        ));
    }

    Ok(CommitPage {
        lane_count: max_lane + 1,
        has_more: end < total,
        commits,
    })
}

/// 建立 oid -> 引用列表 的映射，用于在提交上标注分支/标签。
fn build_ref_map(repo: &Repository) -> AppResult<HashMap<String, Vec<CommitRef>>> {
    let mut map: HashMap<String, Vec<CommitRef>> = HashMap::new();

    let head_target = repo.head().ok().and_then(|h| h.target());

    // 本地分支
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Local)) {
        for entry in branches.flatten() {
            let (branch, _) = entry;
            if let Some(oid) = branch.get().target() {
                let name = branch
                    .name()
                    .ok()
                    .flatten()
                    .unwrap_or("(unnamed)")
                    .to_string();
                let is_head = head_target == Some(oid) && branch.is_head();
                map.entry(oid.to_string())
                    .or_default()
                    .push(CommitRef {
                        kind: RefKind::LocalBranch,
                        name,
                        is_head,
                    });
            }
        }
    }

    // 远程分支
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Remote)) {
        for entry in branches.flatten() {
            let (branch, _) = entry;
            if let Some(oid) = branch.get().target() {
                let name = branch
                    .name()
                    .ok()
                    .flatten()
                    .unwrap_or("(unnamed)")
                    .to_string();
                map.entry(oid.to_string())
                    .or_default()
                    .push(CommitRef {
                        kind: RefKind::RemoteBranch,
                        name,
                        is_head: false,
                    });
            }
        }
    }

    // 标签
    if let Ok(tags) = repo.tag_names(None) {
        for tag in tags.iter().flatten() {
            if let Ok(reference) = repo.find_reference(&format!("refs/tags/{tag}")) {
                // 标签可能指向 commit 也可能是 annotated tag，统一 peel 到 commit
                if let Ok(commit) = reference.peel_to_commit() {
                    map.entry(commit.id().to_string())
                        .or_default()
                        .push(CommitRef {
                            kind: RefKind::Tag,
                            name: tag.to_string(),
                            is_head: false,
                        });
                }
            }
        }
    }

    Ok(map)
}

// ---------------------------------------------------------------------------
// 提交详情
// ---------------------------------------------------------------------------

/// 读取单个提交的详情（含变更文件列表与统计）。
///
/// 变更文件通过「第一父提交 tree → 本提交 tree」的 diff 得出；
/// 根提交则与空 tree 比较（即所有文件都是新增）。
pub fn read_commit_detail(repo: &Repository, oid: &str) -> AppResult<CommitDetail> {
    let oid = Oid::from_str(oid)
        .map_err(|_| crate::error::AppError::State(format!("invalid commit oid: {oid}")))?;
    let commit = repo.find_commit(oid)?;

    let new_tree = commit.tree()?;
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };

    let mut opts = git2::DiffOptions::new();
    opts.include_typechange(true);

    let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;

    // 开启 rename 检测，避免重命名被拆成删除 + 新增
    let mut find = git2::DiffFindOptions::new();
    find.renames(true).rename_threshold(50);
    let _ = diff.find_similar(Some(&mut find));

    let mut files = Vec::new();
    let mut total_add = 0u32;
    let mut total_del = 0u32;

    for (idx, delta) in diff.deltas().enumerate() {
        let status = match delta.status() {
            git2::Delta::Added => crate::model::FileStatus::Added,
            git2::Delta::Deleted => crate::model::FileStatus::Deleted,
            git2::Delta::Modified => crate::model::FileStatus::Modified,
            git2::Delta::Renamed => crate::model::FileStatus::Renamed,
            git2::Delta::Copied => crate::model::FileStatus::Added,
            git2::Delta::Typechange => crate::model::FileStatus::TypeChange,
            _ => crate::model::FileStatus::Modified,
        };

        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        let old_path = delta
            .old_file()
            .path()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .filter(|p| *p != path);

        let binary = delta.new_file().is_binary() || delta.old_file().is_binary();

        let (add, del) = match git2::Patch::from_diff(&diff, idx) {
            Ok(Some(patch)) => patch
                .line_stats()
                .map(|(_, a, d)| (a as u32, d as u32))
                .unwrap_or((0, 0)),
            _ => (0, 0),
        };

        total_add += add;
        total_del += del;

        files.push(crate::model::ChangedFile {
            path,
            old_path: if status == crate::model::FileStatus::Renamed
                || status == crate::model::FileStatus::Deleted
            {
                old_path
            } else {
                None
            },
            status,
            // 提交历史里的变更是「已提交」的，归入 staged 语义
            area: crate::model::StageArea::Staged,
            additions: add,
            deletions: del,
            binary,
        });
    }

    let short = commit
        .as_object()
        .short_id()
        .map(|b| b.as_str().unwrap_or("").to_string())
        .unwrap_or_else(|_| oid.to_string().chars().take(7).collect());

    let author = commit.author();

    Ok(CommitDetail {
        oid: oid.to_string(),
        short_oid: short,
        message: commit.message().unwrap_or("").to_string(),
        summary: commit.summary().unwrap_or("").to_string(),
        author_name: author.name().unwrap_or("(unknown)").to_string(),
        author_email: author.email().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
        parents: commit.parent_ids().map(|p| p.to_string()).collect(),
        file_count: files.len(),
        files,
        additions: total_add,
        deletions: total_del,
    })
}

/// 读取「某个提交中某个文件」的 diff，用于点击提交里的文件时预览。
pub fn read_commit_file_diff(
    repo: &Repository,
    commit_oid: &str,
    path: &str,
) -> AppResult<crate::model::FileDiff> {
    let oid = Oid::from_str(commit_oid)
        .map_err(|_| crate::error::AppError::State(format!("invalid commit oid: {commit_oid}")))?;
    let commit = repo.find_commit(oid)?;
    let new_tree = commit.tree()?;
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };

    // 复用 git.rs 里的 patch 解析，但 diff 源改为两棵树
    crate::git::read_tree_diff_file(repo, parent_tree.as_ref(), &new_tree, path)
}

/// 读取某个提交中单个文件的「修改前 / 修改后」完整内容。
///
/// 用于 VS Code 式全文对比。要点：
/// - 修改前内容取自**第一父提交**的 tree；根提交没有父，`old_exists = false`
/// - 修改后内容取自**本提交**的 tree；文件被删除时 `new_exists = false`
/// - 二进制或超大文件不返回全文（避免 WebView 卡死），只保留 hunks
pub fn read_file_pair(
    repo: &Repository,
    commit_oid: &str,
    path: &str,
) -> AppResult<FilePair> {
    let oid = Oid::from_str(commit_oid)
        .map_err(|_| AppError::State(format!("invalid commit oid: {commit_oid}")))?;
    let commit = repo.find_commit(oid)?;
    let new_tree = commit.tree()?;
    let parent_tree = match commit.parent_count() {
        0 => None,
        _ => Some(commit.parent(0)?.tree()?),
    };

    let normalized = path.replace('\\', "/");

    // 先拿 diff，既用于 hunks，也用于确定真实路径（重命名场景）
    let diff = crate::git::read_tree_diff_file(repo, parent_tree.as_ref(), &new_tree, &normalized)?;

    let old_path = diff.old_path.clone();
    let new_path = diff.path.clone();

    // 取两侧内容
    let old_blob = parent_tree
        .as_ref()
        .and_then(|t| read_blob_at(repo, t, old_path.as_deref().unwrap_or(&new_path)));
    let new_blob = if diff.status == FileStatus::Deleted {
        None
    } else {
        read_blob_at(repo, &new_tree, &new_path)
    };

    // 二进制判定优先用 diff 的结论，其次看 blob
    let binary = diff.binary
        || old_blob.as_ref().map(|b| b.is_binary()).unwrap_or(false)
        || new_blob.as_ref().map(|b| b.is_binary()).unwrap_or(false);

    // 超大保护
    let too_big = old_blob.as_ref().map(|b| b.size() > MAX_PREVIEW_BYTES).unwrap_or(false)
        || new_blob.as_ref().map(|b| b.size() > MAX_PREVIEW_BYTES).unwrap_or(false);

    let truncated = too_big;
    let (old_content, new_content) = if binary || too_big {
        (String::new(), String::new())
    } else {
        (
            old_blob
                .as_ref()
                .map(|b| String::from_utf8_lossy(b.content()).to_string())
                .unwrap_or_default(),
            new_blob
                .as_ref()
                .map(|b| String::from_utf8_lossy(b.content()).to_string())
                .unwrap_or_default(),
        )
    };

    Ok(FilePair {
        path: new_path,
        old_path,
        status: diff.status,
        old_exists: old_blob.is_some(),
        new_exists: new_blob.is_some() && diff.status != FileStatus::Deleted,
        binary,
        truncated,
        hunks: diff.hunks,
        additions: diff.additions,
        deletions: diff.deletions,
        old_content,
        new_content,
    })
}

/// 在指定 tree 中按路径取 blob；路径不存在则返回 None。
fn read_blob_at<'repo>(
    repo: &'repo Repository,
    tree: &git2::Tree<'_>,
    path: &str,
) -> Option<git2::Blob<'repo>> {
    let entry = tree.get_path(std::path::Path::new(path)).ok()?;
    // 只处理文件，跳过目录与子模块
    if entry.kind() != Some(git2::ObjectType::Blob) {
        return None;
    }
    repo.find_blob(entry.id()).ok()
}
//! 工作区全局文件内容搜索引擎（对标 VS Code Search / ripgrep 语义）。
//!
//! 特性：
//! - 使用 `ignore::WalkBuilder` 高速遍历工作区，原生支持 `.gitignore` 与包含/排除 glob 过滤
//! - 使用 `regex::Regex`（线性时间执行，无回溯 ReDoS 风险）支持区分大小写、全词匹配与正则模式
//! - 自动跳过 `.git`、常见构建/依赖缓存、二进制文件及超大文件
//! - 对超长压缩单行自动按首个命中上下文裁剪，并统一换算为 JS UTF-16 代码单元偏移

use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use ignore::overrides::{Override, OverrideBuilder};
use ignore::{WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};

use crate::commands::{is_image_extension, is_markdown_extension};
use crate::error::{AppError, AppResult};

const DEFAULT_MAX_FILES: usize = 200;
const DEFAULT_MAX_MATCHES: usize = 2000;
const MAX_FILE_SEARCH_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MATCHES_PER_LINE: usize = 100;
const BINARY_SNIFF_BYTES: usize = 8192;
const DEFAULT_SEARCH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ContentSearchOptions {
    pub query: String,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub use_regex: bool,
    #[serde(default)]
    pub include_pattern: Option<String>,
    #[serde(default)]
    pub exclude_pattern: Option<String>,
    #[serde(default = "default_true")]
    pub use_ignore_files: bool,
    #[serde(default)]
    pub max_files: Option<usize>,
    #[serde(default)]
    pub max_matches: Option<usize>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct MatchRange {
    /// 命中起始位置（UTF-16 代码单元偏移，可直接供前端 `String.slice` 使用）
    pub start: usize,
    /// 命中结束位置（UTF-16 代码单元偏移，可直接供前端 `String.slice` 使用）
    pub end: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct LineContentMatch {
    /// 1-based 行号
    pub line_number: usize,
    /// 1-based 首个命中点的 UTF-16 列号（基于原始未裁剪行）
    pub column: usize,
    /// 供侧栏树展示的行文本片段（超长行或深度缩进行会做安全裁剪）
    pub line_text: String,
    pub truncated_left: bool,
    pub truncated_right: bool,
    /// `line_text` 内命中的所有片段区间（UTF-16 偏移）
    pub ranges: Vec<MatchRange>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileContentMatch {
    pub path: String,
    pub name: String,
    pub is_markdown: bool,
    pub is_image: bool,
    pub match_count: usize,
    pub matches: Vec<LineContentMatch>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ContentSearchResult {
    pub files: Vec<FileContentMatch>,
    pub total_files: usize,
    pub total_matches: usize,
    pub searched_files: usize,
    pub truncated: bool,
    #[serde(default)]
    pub timed_out: bool,
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn build_search_regex(opts: &ContentSearchOptions) -> AppResult<Regex> {
    let raw = opts.query.as_str();
    let base = if opts.use_regex {
        raw.to_string()
    } else {
        regex::escape(raw)
    };

    let pattern = if opts.whole_word {
        if opts.use_regex {
            format!(r"\b(?:{base})\b")
        } else {
            let prefix = if raw.chars().next().is_some_and(is_word_char) {
                r"\b"
            } else {
                ""
            };
            let suffix = if raw.chars().last().is_some_and(is_word_char) {
                r"\b"
            } else {
                ""
            };
            format!("{prefix}{base}{suffix}")
        }
    } else {
        base
    };

    RegexBuilder::new(&pattern)
        .case_insensitive(!opts.case_sensitive)
        .build()
        .map_err(|e| AppError::State(format!("正则表达式无效: {e}")))
}

fn push_expanded_glob(
    builder: &mut OverrideBuilder,
    raw_token: &str,
    as_exclude: bool,
) -> AppResult<()> {
    let cleaned = raw_token.trim().replace('\\', "/");
    let cleaned = cleaned.trim_start_matches("./").trim_matches('/');
    if cleaned.is_empty() {
        return Ok(());
    }

    let has_glob_meta = cleaned.contains('*')
        || cleaned.contains('?')
        || cleaned.contains('[')
        || cleaned.contains('{');
    let prefix = if as_exclude { "!" } else { "" };

    builder
        .add(&format!("{prefix}{cleaned}"))
        .map_err(|e| AppError::State(format!("路径过滤表达式无效 ({raw_token}): {e}")))?;

    if !has_glob_meta {
        builder
            .add(&format!("{prefix}{cleaned}/**"))
            .map_err(|e| AppError::State(format!("路径过滤表达式无效 ({raw_token}): {e}")))?;
    }

    Ok(())
}

fn build_filter_overrides(
    workdir: &Path,
    include_pattern: Option<&str>,
    exclude_pattern: Option<&str>,
) -> AppResult<(Option<Override>, Option<Override>)> {
    let mut inc_builder = OverrideBuilder::new(workdir);
    let mut exc_builder = OverrideBuilder::new(workdir);
    let mut has_include = false;
    let mut has_exclude = false;

    if let Some(raw_inc) = include_pattern {
        for part in raw_inc.split(',') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Some(neg) = trimmed.strip_prefix('!') {
                push_expanded_glob(&mut exc_builder, neg, true)?;
                has_exclude = true;
            } else {
                push_expanded_glob(&mut inc_builder, trimmed, false)?;
                has_include = true;
            }
        }
    }

    if let Some(raw_exc) = exclude_pattern {
        for part in raw_exc.split(',') {
            let trimmed = part.trim();
            if trimmed.is_empty() {
                continue;
            }
            let pat = trimmed.strip_prefix('!').unwrap_or(trimmed);
            push_expanded_glob(&mut exc_builder, pat, true)?;
            has_exclude = true;
        }
    }

    let include_ov = if has_include {
        Some(
            inc_builder
                .build()
                .map_err(|e| AppError::State(format!("包含规则构建失败: {e}")))?,
        )
    } else {
        None
    };

    let exclude_ov = if has_exclude {
        Some(
            exc_builder
                .build()
                .map_err(|e| AppError::State(format!("排除规则构建失败: {e}")))?,
        )
    } else {
        None
    };

    Ok((include_ov, exclude_ov))
}

fn is_known_binary_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "bmp"
            | "avif"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "eot"
            | "mp3"
            | "mp4"
            | "webm"
            | "ogg"
            | "wav"
            | "flac"
            | "avi"
            | "mov"
            | "zip"
            | "tar"
            | "gz"
            | "bz2"
            | "xz"
            | "7z"
            | "rar"
            | "pdf"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "exe"
            | "dll"
            | "so"
            | "dylib"
            | "lib"
            | "a"
            | "pdb"
            | "obj"
            | "wasm"
            | "node"
            | "class"
            | "jar"
            | "pyc"
            | "pyo"
    )
}

fn should_skip_default_dir(
    path: &Path,
    name: &str,
    use_ignore_files: bool,
    skip_build_dirs: bool,
) -> bool {
    if name == ".git" {
        return true;
    }
    if !use_ignore_files {
        return false;
    }
    if matches!(
        name,
        "node_modules" | ".pnpm-store" | "__pycache__" | ".venv" | ".next" | ".nuxt" | ".turbo"
    ) {
        return true;
    }
    if skip_build_dirs
        && matches!(
            name,
            ".vite" | ".cache" | ".eslintcache" | ".parcel-cache" | "dist" | "build" | "target" | "out" | "coverage"
        )
    {
        return true;
    }
    path.join("CACHEDIR.TAG").exists()
}

fn clip_matched_line(line: &str, raw_byte_ranges: &[(usize, usize)]) -> Option<LineContentMatch> {
    let first = *raw_byte_ranges.first()?;
    let column = line[..first.0].encode_utf16().count() + 1;

    let trimmed_start = line.trim_start_matches(|c: char| c == ' ' || c == '\t');
    let leading_ws = line.len() - trimmed_start.len();
    let content_start = if first.0 < leading_ws { 0 } else { leading_ws };

    let content_slice = &line[content_start..];
    let chars_before_first = line[content_start..first.0].chars().count();
    let content_char_count = content_slice.chars().count();

    let (window_start, window_end) = if chars_before_first <= 60 && content_char_count <= 240 {
        (content_start, line.len())
    } else {
        let win_start_char = chars_before_first.saturating_sub(48);
        let win_end_char = win_start_char + 220;

        let mut ws_byte = content_start;
        let mut we_byte = line.len();
        let mut found_end = false;
        for (idx, (rel_b, _)) in content_slice.char_indices().enumerate() {
            if idx == win_start_char {
                ws_byte = content_start + rel_b;
            }
            if idx == win_end_char {
                we_byte = content_start + rel_b;
                found_end = true;
                break;
            }
        }
        if !found_end {
            we_byte = line.len();
        }
        (ws_byte, we_byte)
    };

    let truncated_left = window_start > content_start;
    let truncated_right = window_end < line.len();
    let core = &line[window_start..window_end];
    let prefix = if truncated_left { "…" } else { "" };
    let suffix = if truncated_right { "…" } else { "" };
    let prefix_utf16 = if truncated_left { 1usize } else { 0usize };

    let mut ranges = Vec::with_capacity(raw_byte_ranges.len());
    for &(b_start, b_end) in raw_byte_ranges {
        if b_end <= window_start || b_start >= window_end {
            continue;
        }
        let rel_s = b_start.max(window_start) - window_start;
        let rel_e = b_end.min(window_end) - window_start;
        let start = prefix_utf16 + core[..rel_s].encode_utf16().count();
        let end = prefix_utf16 + core[..rel_e].encode_utf16().count();
        if end > start {
            ranges.push(MatchRange { start, end });
        }
    }

    if ranges.is_empty() {
        return None;
    }

    Some(LineContentMatch {
        line_number: 0,
        column,
        line_text: format!("{prefix}{core}{suffix}"),
        truncated_left,
        truncated_right,
        ranges,
    })
}

fn search_single_file(
    abs_path: &Path,
    regex: &Regex,
    remaining_matches: usize,
) -> Option<(Vec<LineContentMatch>, usize, bool)> {
    let meta = std::fs::metadata(abs_path).ok()?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_FILE_SEARCH_BYTES {
        return None;
    }

    let mut file = File::open(abs_path).ok()?;
    let mut sniff = [0u8; BINARY_SNIFF_BYTES];
    let sniff_n = file.read(&mut sniff).ok()?;
    if sniff_n == 0 || sniff[..sniff_n].contains(&0) {
        return None;
    }

    let mut bytes = if sniff_n < BINARY_SNIFF_BYTES {
        sniff[..sniff_n].to_vec()
    } else {
        let mut buf = Vec::with_capacity((meta.len() as usize).min(65536).max(sniff_n));
        buf.extend_from_slice(&sniff[..sniff_n]);
        if file.read_to_end(&mut buf).is_err() {
            return None;
        }
        buf
    };

    if bytes.len() > MAX_FILE_SEARCH_BYTES as usize {
        bytes.truncate(MAX_FILE_SEARCH_BYTES as usize);
    }

    let text = String::from_utf8(bytes).ok()?;
    let mut line_matches = Vec::new();
    let mut file_hit_count = 0usize;
    let mut hit_cap = false;

    for (idx, raw_line) in text.split('\n').enumerate() {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let mut raw_ranges: Vec<(usize, usize)> = Vec::new();
        for m in regex.find_iter(line) {
            if m.start() == m.end() {
                continue;
            }
            raw_ranges.push((m.start(), m.end()));
            if raw_ranges.len() >= MAX_MATCHES_PER_LINE {
                break;
            }
        }
        if raw_ranges.is_empty() {
            continue;
        }

        if let Some(mut clipped) = clip_matched_line(line, &raw_ranges) {
            let remaining_after_line = remaining_matches.saturating_sub(file_hit_count);
            if remaining_after_line == 0 {
                hit_cap = true;
                break;
            }
            let added = raw_ranges.len().min(remaining_after_line);
            clipped.line_number = idx + 1;
            line_matches.push(clipped);
            file_hit_count += added;
            if file_hit_count >= remaining_matches {
                hit_cap = true;
                break;
            }
        }
    }

    if line_matches.is_empty() {
        None
    } else {
        Some((line_matches, file_hit_count, hit_cap))
    }
}

/// 在工作区内全局搜索文件内容（默认不可取消快捷入口，供测试与内部直接调用）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn search_content_internal(
    workdir: &Path,
    opts: &ContentSearchOptions,
) -> AppResult<ContentSearchResult> {
    search_content_cancellable(workdir, opts, || false)
}

/// 在工作区内多核并行搜索文件内容，支持外部代际取消与 15 秒扫描保护上限。
pub fn search_content_cancellable<F>(
    workdir: &Path,
    opts: &ContentSearchOptions,
    should_cancel: F,
) -> AppResult<ContentSearchResult>
where
    F: Fn() -> bool + Sync,
{
    if opts.query.is_empty() || (!opts.use_regex && opts.query.trim().is_empty()) {
        return Ok(ContentSearchResult {
            files: Vec::new(),
            total_files: 0,
            total_matches: 0,
            searched_files: 0,
            truncated: false,
            timed_out: false,
        });
    }

    if !workdir.exists() || !workdir.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Workspace directory does not exist: {}",
            workdir.to_string_lossy()
        )));
    }

    let regex = build_search_regex(opts)?;
    let (include_ov, exclude_ov) = build_filter_overrides(
        workdir,
        opts.include_pattern.as_deref(),
        opts.exclude_pattern.as_deref(),
    )?;

    let max_files = opts.max_files.unwrap_or(DEFAULT_MAX_FILES).max(1);
    let max_matches = opts.max_matches.unwrap_or(DEFAULT_MAX_MATCHES).max(1);
    let use_ignore = opts.use_ignore_files;
    let skip_build_dirs = use_ignore && include_ov.is_none();
    let skip_binary_ext = use_ignore && include_ov.is_none();

    let worker_count = std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, 6))
        .unwrap_or(4);

    let mut builder = WalkBuilder::new(workdir);
    builder
        .hidden(false)
        .follow_links(false)
        .git_ignore(use_ignore)
        .git_exclude(use_ignore)
        .git_global(false)
        .parents(use_ignore)
        .ignore(use_ignore)
        .threads(worker_count);

    let workdir_for_filter = workdir.to_path_buf();
    let exclude_ov_for_filter = exclude_ov.clone();
    builder.filter_entry(move |entry| {
        let is_dir = entry.file_type().is_some_and(|ft| ft.is_dir());
        let name = entry.file_name().to_string_lossy();
        if entry.depth() > 0
            && is_dir
            && should_skip_default_dir(entry.path(), &name, use_ignore, skip_build_dirs)
        {
            return false;
        }
        if entry.depth() > 0 {
            if let Some(ref ex) = exclude_ov_for_filter {
                if let Ok(rel) = entry.path().strip_prefix(&workdir_for_filter) {
                    if ex.matched(rel, is_dir).is_ignore() {
                        return false;
                    }
                }
            }
        }
        true
    });

    let started_at = Instant::now();
    let results_lock = Mutex::new(Vec::<FileContentMatch>::new());
    let total_matches = AtomicUsize::new(0);
    let searched_files = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    let timed_out = AtomicBool::new(false);
    let done = AtomicBool::new(false);

    builder.build_parallel().run(|| {
        let regex = &regex;
        let include_ov = &include_ov;
        let results_lock = &results_lock;
        let total_matches = &total_matches;
        let searched_files = &searched_files;
        let truncated = &truncated;
        let timed_out = &timed_out;
        let done = &done;
        let should_cancel = &should_cancel;

        Box::new(move |dent_res| {
            if done.load(Ordering::Relaxed) || should_cancel() {
                done.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }
            if started_at.elapsed() >= DEFAULT_SEARCH_TIMEOUT {
                timed_out.store(true, Ordering::Relaxed);
                truncated.store(true, Ordering::Relaxed);
                done.store(true, Ordering::Relaxed);
                return WalkState::Quit;
            }

            let Ok(dent) = dent_res else {
                return WalkState::Continue;
            };
            if !dent.file_type().is_some_and(|ft| ft.is_file()) {
                return WalkState::Continue;
            }

            let abs_path = dent.path();
            let Ok(rel) = abs_path.strip_prefix(workdir) else {
                return WalkState::Continue;
            };

            if let Some(inc) = include_ov.as_ref() {
                if !inc.matched(rel, false).is_whitelist() {
                    return WalkState::Continue;
                }
            }

            let name = dent.file_name().to_string_lossy().to_string();
            let ext = Path::new(&name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            if skip_binary_ext && is_known_binary_extension(ext) {
                return WalkState::Continue;
            }

            searched_files.fetch_add(1, Ordering::Relaxed);

            if let Some((mut line_matches, mut file_hits, hit_cap)) =
                search_single_file(abs_path, regex, max_matches)
            {
                let rel_path = rel.to_string_lossy().replace('\\', "/");
                let is_markdown = is_markdown_extension(ext);
                let is_image = is_image_extension(ext);

                let mut guard = match results_lock.lock() {
                    Ok(g) => g,
                    Err(e) => e.into_inner(),
                };

                let cur_total = total_matches.load(Ordering::Relaxed);
                if done.load(Ordering::Relaxed) || guard.len() >= max_files || cur_total >= max_matches {
                    truncated.store(true, Ordering::Relaxed);
                    done.store(true, Ordering::Relaxed);
                    return WalkState::Quit;
                }

                let remaining = max_matches.saturating_sub(cur_total);
                let mut local_capped = hit_cap;
                if file_hits > remaining {
                    // 多线程下二次裁剪超出全局上限的行命中
                    let mut kept = Vec::new();
                    let mut acc = 0usize;
                    for mut lm in line_matches.drain(..) {
                        if acc >= remaining {
                            local_capped = true;
                            break;
                        }
                        let take = lm.ranges.len().min(remaining - acc);
                        if take < lm.ranges.len() {
                            lm.ranges.truncate(take);
                            local_capped = true;
                        }
                        acc += take;
                        kept.push(lm);
                    }
                    line_matches = kept;
                    file_hits = acc;
                }

                if !line_matches.is_empty() && file_hits > 0 {
                    guard.push(FileContentMatch {
                        path: rel_path,
                        name,
                        is_markdown,
                        is_image,
                        match_count: file_hits,
                        matches: line_matches,
                    });
                    let new_total = total_matches.fetch_add(file_hits, Ordering::Relaxed) + file_hits;
                    if local_capped || guard.len() >= max_files || new_total >= max_matches {
                        truncated.store(true, Ordering::Relaxed);
                        done.store(true, Ordering::Relaxed);
                        return WalkState::Quit;
                    }
                }
            }

            WalkState::Continue
        })
    });

    if should_cancel() {
        return Ok(ContentSearchResult {
            files: Vec::new(),
            total_files: 0,
            total_matches: 0,
            searched_files: 0,
            truncated: false,
            timed_out: false,
        });
    }

    let mut files = results_lock
        .into_inner()
        .unwrap_or_else(|e| e.into_inner());
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let total_files = files.len();
    let total_match_count = files.iter().map(|f| f.match_count).sum();
    Ok(ContentSearchResult {
        files,
        total_files,
        total_matches: total_match_count,
        searched_files: searched_files.load(Ordering::Relaxed),
        truncated: truncated.load(Ordering::Relaxed),
        timed_out: timed_out.load(Ordering::Relaxed),
    })
}

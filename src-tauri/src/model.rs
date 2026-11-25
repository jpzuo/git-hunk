//! 前后端共享的数据模型。
//!
//! 关键设计：`Hunk` 是从 git diff 补丁解析出的**稳定、自洽的**行区间模型，
//! 它同时服务于 stage / discard / 冲突解决 / AI 提示等场景，因此必须承载足够信息：
//!
//! - `old_start` / `old_lines`：源侧（HEAD 或索引）行区间
//! - `new_start` / `new_lines`：目标侧（工作区）行区间
//! - `lines`：逐行内容与类型，用于渲染与重建补丁
//!
//! 部分判断方法当前版本暂未调用，但属于后续阶段（冲突解决、AI 提示）的公开契约，
//! 因此统一允许 dead_code，避免用 `#[allow]` 把整个模块的告警关掉。

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

/// 单个文件在仓库中的变更状态。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
    TypeChange,
}

impl FileStatus {
    pub fn is_conflicted(self) -> bool {
        matches!(self, FileStatus::Conflicted)
    }
}

/// 一个文件的变更加入暂存区（staged）的归属。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageArea {
    /// 已暂存（索引相对 HEAD 的变更）
    Staged,
    /// 未暂存（工作区相对索引的变更）
    Unstaged,
    /// 未跟踪文件（尚未进入索引）
    Untracked,
}

/// 变更文件条目。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedFile {
    /// 仓库相对路径，统一使用 `/` 分隔。
    pub path: String,
    /// 重命名前的旧路径（仅 Renamed 时有值）。
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub area: StageArea,
    /// 该文件新增行数（基于当前 area 的 diff）。
    pub additions: u32,
    /// 该文件删除行数。
    pub deletions: u32,
    /// 是否为二进制文件。
    pub binary: bool,
}

/// 仓库整体状态，对应 Source Control 面板的三组。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoStatus {
    /// 仓库根目录绝对路径。
    pub workdir: String,
    /// 当前分支名；detached HEAD 时为 None。
    pub branch: Option<String>,
    /// HEAD 是否处于 detached 状态。
    pub detached: bool,
    /// ahead（本地领先远端）的 commit 数。
    pub ahead: u32,
    /// behind（本地落后远端）的 commit 数。
    pub behind: u32,
    pub staged: Vec<ChangedFile>,
    pub unstaged: Vec<ChangedFile>,
    pub untracked: Vec<ChangedFile>,
}

impl RepoStatus {
    pub fn total_changes(&self) -> usize {
        self.staged.len() + self.unstaged.len() + self.untracked.len()
    }
}

/// diff 中一行的类型。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HunkLineKind {
    /// 上下文行（未变更）
    Context,
    /// 新增行
    Addition,
    /// 删除行
    Deletion,
}

impl HunkLineKind {
    pub fn prefix(self) -> char {
        match self {
            HunkLineKind::Context => ' ',
            HunkLineKind::Addition => '+',
            HunkLineKind::Deletion => '-',
        }
    }
}

/// diff 中的一行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HunkLine {
    pub kind: HunkLineKind,
    /// 行内容（不含前导 `+`/`-`/空格，不含行尾换行）。
    pub content: String,
    /// 源侧行号（1-based）；新增行为 None。
    pub old_lineno: Option<u32>,
    /// 目标侧行号（1-based）；删除行为 None。
    pub new_lineno: Option<u32>,
    /// 源文本是否没有行尾换行（`\ No newline at end of file`）。
    pub no_newline: bool,
}

/// 一个 hunk —— 本产品的核心操作单元。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hunk {
    /// 在所属文件 diff 中的序号（0-based），前端按它回传操作目标。
    pub index: usize,
    /// diff header 中的完整 `@@ -a,b +c,d @@` 原始文本（含可能的 section heading）。
    pub header: String,
    /// 源侧起始行（1-based；0 表示空区间，例如新文件为 0）。
    pub old_start: u32,
    /// 源侧行数。
    pub old_lines: u32,
    /// 目标侧起始行（1-based）。
    pub new_start: u32,
    /// 目标侧行数。
    pub new_lines: u32,
    pub lines: Vec<HunkLine>,
    /// 该 hunk 的新增行数。
    pub additions: u32,
    /// 该 hunk 的删除行数。
    pub deletions: u32,
}

impl Hunk {
    /// 该 hunk 是否只包含新增行（可用于判断是否为纯插入）。
    pub fn is_pure_addition(&self) -> bool {
        self.deletions == 0 && self.additions > 0
    }

    /// 该 hunk 是否只包含删除行。
    pub fn is_pure_deletion(&self) -> bool {
        self.additions == 0 && self.deletions > 0
    }
}

/// 单个文件的完整 diff。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub area: StageArea,
    pub binary: bool,
    /// 只读预览内容：二进制文件时为空。
    pub hunks: Vec<Hunk>,
    pub additions: u32,
    pub deletions: u32,
    /// 当 blob 过大而被判定为不可预览时为 true。
    pub truncated: bool,
}

/// 提交结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitResult {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
}

// ---------------------------------------------------------------------------
// 提交历史与 DAG
// ---------------------------------------------------------------------------

/// 引用类型，用于在提交图上做装饰。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    /// 本地分支
    LocalBranch,
    /// 远程分支
    RemoteBranch,
    /// 标签
    Tag,
    /// 当前 HEAD
    Head,
}

/// 挂在某个提交上的引用（分支 / 标签 / HEAD）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitRef {
    pub kind: RefKind,
    /// 展示名，例如 `main`、`origin/main`、`v1.0.0`。
    pub name: String,
    /// 该引用是否指向当前 HEAD。
    pub is_head: bool,
}

/// 提交图上一条连线（本行到下一行之间的一段）。
///
/// `from_lane == to_lane` 表示竖直直连；不同则表示该提交的父提交在别的泳道，
/// 需要画斜线/曲线。前端按 `(from_lane, y_row) -> (to_lane, y_next)` 连线即可。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct LaneSegment {
    pub from_lane: u32,
    pub to_lane: u32,
}

/// 提交图上的一行。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphCommit {
    pub oid: String,
    pub short_oid: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// Unix 时间戳（秒）。
    pub timestamp: i64,
    /// 父提交 oid 列表（合并提交有多个）。
    pub parents: Vec<String>,
    /// 该提交所在的泳道序号（0 起）。
    pub lane: u32,
    /// 本行渲染所需的全部连线：包含「穿过本行的其他泳道」与本提交到父提交的连线。
    pub segments: Vec<LaneSegment>,
    /// 本提交有多个父提交时，额外分叉出的泳道序号（便于测试与高亮）。
    pub merge_lanes: Vec<u32>,
    /// 挂在该提交上的引用。
    pub refs: Vec<CommitRef>,
    /// 该提交是否是当前 HEAD。
    pub is_head: bool,
}

/// 提交历史页。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitPage {
    pub commits: Vec<GraphCommit>,
    /// 本次渲染用到的最大泳道数，用于前端计算 SVG 宽度。
    pub lane_count: u32,
    /// 是否还有更多（用于滚动加载）。
    pub has_more: bool,
}

/// 提交详情。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommitDetail {
    pub oid: String,
    pub short_oid: String,
    pub message: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    /// 该提交相对第一父提交的变更文件列表。
    pub files: Vec<ChangedFile>,
    /// 变更文件总数。
    pub file_count: usize,
    pub additions: u32,
    pub deletions: u32,
}

/// 某提交中单个文件的「修改前 / 修改后」完整内容，用于 VS Code 式全文对比。
///
/// 设计说明：`hunks` 与 `old_content`/`new_content` 是互补的 ——
/// hunks 给出「哪里变了」，完整内容给出「全文是什么」。前端用 hunks 定位
/// 变更区间，用全文填充未变更部分并做折叠，两者都不可少。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilePair {
    /// 当前路径（重命名后为新路径）。
    pub path: String,
    /// 重命名前的旧路径（仅重命名时有值）。
    pub old_path: Option<String>,
    pub status: FileStatus,
    /// 修改前的完整文本。新增文件时为空。
    pub old_content: String,
    /// 修改后的完整文本。删除文件时为空。
    pub new_content: String,
    /// 修改前是否存在（新增文件 / 根提交时为 false）。
    pub old_exists: bool,
    /// 修改后是否存在（删除文件时为 false）。
    pub new_exists: bool,
    pub binary: bool,
    /// 文件过大时截断，此时内容为空、只保留 hunks。
    pub truncated: bool,
    /// 变更块，供前端定位折叠区间。
    pub hunks: Vec<Hunk>,
    pub additions: u32,
    pub deletions: u32,
}

/// 单个 blob 允许传给前端预览的最大字节数（2 MiB）。
///
/// 超过此值的文件只返回 hunks，避免一次把几十 MB 文本塞进 WebView。
pub const MAX_PREVIEW_BYTES: usize = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 分支、Stash、Tag、Remote 扩展模型
// ---------------------------------------------------------------------------

/// 分支条目信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub target_oid: String,
    pub target_summary: String,
    pub ahead: u32,
    pub behind: u32,
}

/// 工作区储藏记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StashInfo {
    pub index: usize,
    pub name: String,
    pub message: String,
    pub oid: String,
    pub timestamp: i64,
}

/// 标签条目信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagInfo {
    pub name: String,
    pub target_oid: String,
    pub target_summary: String,
    pub message: Option<String>,
    pub tagger: Option<String>,
    pub timestamp: Option<i64>,
}

/// 远程配置信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteInfo {
    pub name: String,
    pub url: Option<String>,
    pub push_url: Option<String>,
}

/// 远程网络操作执行结果（push / pull / fetch）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

/// 工作区摘要条目（供前端 Tab 标签和工作区列表展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceSummary {
    pub path: String,
    pub name: String,
    pub project_name: String,
    pub original_name: String,
    pub alias: Option<String>,
    pub group: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub is_active: bool,
    pub has_changes: bool,
}

// ---------------------------------------------------------------------------
// 仓库统一管理与分组模型
// ---------------------------------------------------------------------------

/// 仓库持久化条目
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogRepo {
    pub path: String,
    pub alias: Option<String>,
    pub group: String,
    pub last_opened: i64,
    pub is_pinned: bool,
}

/// 分组元数据
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CatalogGroup {
    pub name: String,
    pub order: usize,
}

/// 仓库管理清单实体
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RepositoryCatalog {
    pub groups: Vec<CatalogGroup>,
    pub repos: Vec<CatalogRepo>,
}

impl Default for RepositoryCatalog {
    fn default() -> Self {
        Self {
            groups: Vec::new(),
            repos: Vec::new(),
        }
    }
}

/// 供前端仓库管理面板展示的条目完整信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogItemSummary {
    pub path: String,
    pub display_name: String,
    pub original_name: String,
    pub alias: Option<String>,
    pub group: String,
    pub last_opened: i64,
    pub is_pinned: bool,
    pub is_open: bool,
    pub is_active: bool,
    pub current_branch: Option<String>,
    pub has_changes: bool,
    pub worktree_count: usize,
    pub is_worktree: bool,
    pub is_main_worktree: bool,
    pub linked_worktrees: Vec<WorktreeInfo>,
}

/// Git 工作树信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub name: String,
    pub head_oid: String,
    pub branch: Option<String>,
    pub is_main: bool,
}


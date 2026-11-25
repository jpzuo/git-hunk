/** 与 Rust 侧 `model.rs` 一一对应的前端类型。 */

export type FileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "type_change";

export type StageArea = "staged" | "unstaged" | "untracked";

export interface ChangedFile {
  path: string;
  old_path: string | null;
  status: FileStatus;
  area: StageArea;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RepoStatus {
  workdir: string;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  staged: ChangedFile[];
  unstaged: ChangedFile[];
  untracked: ChangedFile[];
}

export type HunkLineKind = "context" | "addition" | "deletion";

export interface HunkLine {
  kind: HunkLineKind;
  content: string;
  old_lineno: number | null;
  new_lineno: number | null;
  no_newline: boolean;
}

export interface Hunk {
  index: number;
  header: string;
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: HunkLine[];
  additions: number;
  deletions: number;
}

export interface FileDiff {
  path: string;
  old_path: string | null;
  status: FileStatus;
  area: StageArea;
  binary: boolean;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  truncated: boolean;
}

export interface CommitResult {
  oid: string;
  short_oid: string;
  summary: string;
}

export interface RepoOpenResult {
  status: RepoStatus;
}

// ---------------------------------------------------------------------------
// 扩展能力类型：分支、Stash、Tag、Remote
// ---------------------------------------------------------------------------

export interface BranchInfo {
  name: string;
  is_head: boolean;
  is_remote: boolean;
  upstream: string | null;
  target_oid: string;
  target_summary: string;
  ahead: number;
  behind: number;
}

export interface StashInfo {
  index: number;
  name: string;
  message: string;
  oid: string;
  timestamp: number;
}

export interface TagInfo {
  name: string;
  target_oid: string;
  target_summary: string;
  message: string | null;
  tagger: string | null;
  timestamp: number | null;
}

export interface RemoteInfo {
  name: string;
  url: string | null;
  push_url: string | null;
}

export interface SyncResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// 多工作区类型
// ---------------------------------------------------------------------------

export interface WorkspaceSummary {
  path: string;
  name: string;
  project_name?: string;
  original_name?: string;
  alias?: string | null;
  group?: string | null;
  branch: string | null;
  detached: boolean;
  is_active: boolean;
  has_changes: boolean;
}

// ---------------------------------------------------------------------------
// 仓库统一管理中心与项目分组类型
// ---------------------------------------------------------------------------

export interface CatalogRepo {
  path: string;
  alias: string | null;
  group: string;
  last_opened: number;
  is_pinned: boolean;
}

export interface CatalogGroup {
  name: string;
  order: number;
}

export interface CatalogItemSummary {
  path: string;
  display_name: string;
  original_name: string;
  alias: string | null;
  group: string;
  last_opened: number;
  is_pinned: boolean;
  is_open: boolean;
  is_active: boolean;
  current_branch: string | null;
  has_changes: boolean;
  worktree_count: number;
  is_worktree?: boolean;
  is_main_worktree?: boolean;
  linked_worktrees?: WorktreeInfo[];
}

export interface WorktreeInfo {
  path: string;
  name: string;
  head_oid: string;
  branch: string | null;
  is_main: boolean;
}

// ---------------- 工作区文件目录与只读预览 ----------------

export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  is_markdown: boolean;
  is_image: boolean;
  size: number;
}

export interface FileSearchResult {
  matches: FileEntry[];
  truncated: boolean;
}

export interface ContentSearchOptions {
  query: string;
  case_sensitive?: boolean;
  whole_word?: boolean;
  use_regex?: boolean;
  include_pattern?: string;
  exclude_pattern?: string;
  use_ignore_files?: boolean;
  max_files?: number;
  max_matches?: number;
}

export interface MatchRange {
  start: number;
  end: number;
}

export interface LineContentMatch {
  line_number: number;
  column: number;
  line_text: string;
  truncated_left: boolean;
  truncated_right: boolean;
  ranges: MatchRange[];
}

export interface FileContentMatch {
  path: string;
  name: string;
  is_markdown: boolean;
  is_image: boolean;
  match_count: number;
  matches: LineContentMatch[];
}

export interface ContentSearchResult {
  files: FileContentMatch[];
  total_files: number;
  total_matches: number;
  searched_files: number;
  truncated: boolean;
  timed_out?: boolean;
}

export interface SearchHighlightSpec {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  activeLine?: number;
  activeColumn?: number;
}

export interface FilePreviewResult {
  path: string;
  name: string;
  is_binary: boolean;
  is_image: boolean;
  is_markdown: boolean;
  mime_type?: string;
  text_content?: string;
  base64_content?: string;
  size: number;
  line_count?: number;
}

// ---------------- 全局多标签页系统 (VS Code 风格) ----------------

export type TabKind = "preview" | "workdir-diff" | "commit-diff" | "stash-diff";

export interface EditorTab {
  id: string;
  kind: TabKind;
  title: string;
  subtitle?: string;
  path: string;
  isReadOnly?: boolean;
  statusKind?: FileStatus;
  statusLabel?: string;

  // 专属上下文载荷
  workdirArea?: StageArea;
  commitOid?: string;
  commitOldOid?: string;
  stashOid?: string;
  stashIndex?: number;
  targetLine?: number;
  targetColumn?: number;
  jumpNonce?: number;
  searchHighlight?: SearchHighlightSpec;
}

// ---------------- 多语言项目脚本与内置运行器 ----------------

export interface ScriptItem {
  id: string;
  name: string;
  ecosystem: string;
  source_label: string;
  source_file: string;
  cwd: string;
  program: string;
  args: string[];
  display_command: string;
  detail?: string | null;
  is_long_running: boolean;
}

export interface ScriptGroup {
  key: string;
  ecosystem: string;
  source_label: string;
  source_file: string;
  cwd: string;
  package_manager?: string | null;
  scripts: ScriptItem[];
}

export interface ScriptRunSession {
  run_id: string;
  workdir: string;
  script_id: string;
  name: string;
  cwd: string;
  display_command: string;
  status: string;
  exit_code: number | null;
  started_at: number;
}

export interface ScriptOutputEvent {
  run_id: string;
  stream: "stdout" | "stderr" | string;
  chunk: string;
}

export interface ScriptExitEvent {
  run_id: string;
  exit_code: number | null;
  success: boolean;
  stopped_by_user: boolean;
}

export type ScriptRunStatus = "running" | "success" | "failed" | "stopped";

export interface ScriptLogLine {
  id: number;
  stream: "stdout" | "stderr" | "system";
  text: string;
}

export interface ScriptRunRecord {
  run_id: string;
  workdir: string;
  script: ScriptItem;
  status: ScriptRunStatus;
  exit_code: number | null;
  started_at: number;
  ended_at?: number;
  lines: ScriptLogLine[];
  partial_line: string;
}




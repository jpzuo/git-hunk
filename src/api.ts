/** Tauri invoke 的类型化封装。所有后端调用都从这里走，便于集中处理错误。 */

import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  BranchInfo,
  CatalogItemSummary,
  CommitResult,
  FileDiff,
  RemoteInfo,
  RepoStatus,
  StageArea,
  StashInfo,
  SyncResult,
  TagInfo,
  WorkspaceSummary,
  WorktreeInfo,
  FileEntry,
  FilePreviewResult,
  FileSearchResult,
  ContentSearchOptions,
  ContentSearchResult,
  ScriptGroup,
  ScriptItem,
  ScriptRunSession,
  UpdateInfo,
  UpdateProgress,
} from "./types";
import type { CommitDetail, CommitPage, FilePair } from "./historyTypes";

export class GitHunkError extends Error {}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new GitHunkError(typeof e === "string" ? e : String(e));
  }
}

export const api = {
  openRepo: (path: string) => call<RepoStatus>("repo_open", { path }),
  discoverRepo: (path: string) => call<string | null>("repo_discover", { path }),
  status: () => call<RepoStatus>("repo_status"),
  fileDiff: (path: string, area: StageArea) =>
    call<FileDiff>("repo_diff_file", { path, area }),
  workdirFilePair: (path: string, area: StageArea) =>
    call<FilePair>("repo_workdir_file_pair", { path, area }),

  stageFile: (path: string) => call<void>("repo_stage_file", { path }),
  unstageFile: (path: string) => call<void>("repo_unstage_file", { path }),
  discardFile: (path: string, area: StageArea) =>
    call<void>("repo_discard_file", { path, area }),

  stagePaths: (paths: string[]) => call<void>("repo_stage_paths", { paths }),
  unstagePaths: (paths: string[]) => call<void>("repo_unstage_paths", { paths }),
  discardPaths: (paths: string[]) => call<void>("repo_discard_paths", { paths }),
  cleanUntrackedPaths: (paths: string[]) =>
    call<void>("repo_clean_untracked_paths", { paths }),
  discardAllUnstaged: () => call<SyncResult>("repo_discard_all_unstaged"),
  unstageAll: () => call<SyncResult>("repo_unstage_all"),
  sync: () => call<SyncResult>("repo_sync"),
  addToGitignore: (pattern: string) =>
    call<void>("repo_add_to_gitignore", { pattern }),

  // ---------------- 系统联动 ----------------
  openFile: (path: string) => call<void>("system_open_file", { path }),
  revealInExplorer: (path: string) =>
    call<void>("system_reveal_in_explorer", { path }),
  openTerminal: (path: string) => call<void>("system_open_terminal", { path }),

  stageHunk: (path: string, hunkIndex: number) =>
    call<void>("repo_stage_hunk", { path, hunkIndex }),
  unstageHunk: (path: string, hunkIndex: number) =>
    call<void>("repo_unstage_hunk", { path, hunkIndex }),
  discardHunk: (path: string, hunkIndex: number) =>
    call<void>("repo_discard_hunk", { path, hunkIndex }),

  commit: (message: string) => call<CommitResult>("repo_commit", { message }),
  amend: (message: string) => call<CommitResult>("repo_amend", { message }),
  undoCommit: () => call<SyncResult>("repo_undo_commit"),
  discardAllChanges: () => call<SyncResult>("repo_discard_all_changes"),
  cleanUntracked: () => call<SyncResult>("repo_clean_untracked"),
  abortMerge: () => call<SyncResult>("repo_abort_merge"),
  abortRebase: () => call<SyncResult>("repo_abort_rebase"),
  abortCherryPick: () => call<SyncResult>("repo_abort_cherry_pick"),

  // ---------------- 提交历史 ----------------
  history: (
    limit: number,
    skip: number,
    branch?: string | null,
    query?: string | null,
  ) =>
    call<CommitPage>("repo_history", {
      limit,
      skip,
      branch: branch ?? null,
      query: query ?? null,
    }),
  commitDetail: (oid: string) =>
    call<CommitDetail>("repo_commit_detail", { oid }),
  commitFileDiff: (oid: string, path: string) =>
    call<FileDiff>("repo_commit_file_diff", { oid, path }),
  /** 提交中单个文件的修改前后完整内容（全文对比用）。 */
  commitFilePair: (oid: string, path: string) =>
    call<FilePair>("repo_commit_file_pair", { oid, path }),

  // ---------------- 分支 ----------------
  branches: () => call<BranchInfo[]>("repo_branches"),
  createBranch: (name: string, targetOid?: string) =>
    call<void>("repo_branch_create", { name, targetOid: targetOid ?? null }),
  checkoutBranch: (name: string) =>
    call<SyncResult>("repo_branch_checkout", { name }),
  deleteBranch: (name: string, force = false, deleteRemote = false) =>
    call<SyncResult>("repo_branch_delete", { name, force, deleteRemote }),
  renameBranch: (oldName: string, newName: string) =>
    call<void>("repo_branch_rename", { oldName, newName }),

  // ---------------- 远程 ----------------
  remotes: () => call<RemoteInfo[]>("repo_remotes"),
  fetch: (remote?: string) =>
    call<SyncResult>("repo_fetch", { remote: remote ?? null }),
  pull: (remote?: string, branch?: string, rebase = false) =>
    call<SyncResult>("repo_pull", {
      remote: remote ?? null,
      branch: branch ?? null,
      rebase,
    }),
  push: (
    remote?: string,
    branch?: string,
    setUpstream = false,
    force = false,
  ) =>
    call<SyncResult>("repo_push", {
      remote: remote ?? null,
      branch: branch ?? null,
      setUpstream,
      force,
    }),

  // ---------------- Stash ----------------
  stashes: () => call<StashInfo[]>("repo_stashes"),
  stashSave: (
    message?: string,
    includeUntracked = false,
    keepIndex = false,
  ) =>
    call<SyncResult>("repo_stash_save", {
      message: message ?? null,
      includeUntracked,
      keepIndex,
    }),
  stashPop: (index: number) => call<SyncResult>("repo_stash_pop", { index }),
  stashApply: (index: number) => call<SyncResult>("repo_stash_apply", { index }),
  stashDrop: (index: number) => call<SyncResult>("repo_stash_drop", { index }),
  stashClear: () => call<SyncResult>("repo_stash_clear"),
  stashBranch: (branchName: string, index: number) =>
    call<SyncResult>("repo_stash_branch", { branchName, index }),

  // ---------------- 标签 ----------------
  tags: () => call<TagInfo[]>("repo_tags"),
  createTag: (
    name: string,
    targetOid?: string,
    message?: string,
    force?: boolean,
    pushRemote?: boolean,
  ) =>
    call<SyncResult>("repo_tag_create", {
      name,
      targetOid: targetOid ?? null,
      message: message ?? null,
      force: force ?? false,
      pushRemote: pushRemote ?? false,
    }),
  deleteTag: (name: string, deleteRemote?: boolean, remote?: string) =>
    call<SyncResult>("repo_tag_delete", {
      name,
      deleteRemote: deleteRemote ?? false,
      remote: remote ?? null,
    }),
  pushTag: (name: string, remote?: string) =>
    call<SyncResult>("repo_tag_push", { name, remote: remote ?? null }),
  pushAllTags: (remote?: string) =>
    call<SyncResult>("repo_tag_push_all", { remote: remote ?? null }),
  checkoutTag: (name: string) =>
    call<SyncResult>("repo_tag_checkout", { name }),

  // ---------------- 多工作区 ----------------
  openWorkspace: (path: string) =>
    call<RepoStatus>("workspace_open", { path }),
  switchWorkspace: (path: string) =>
    call<RepoStatus>("workspace_switch", { path }),
  closeWorkspace: (path: string) =>
    call<RepoStatus | null>("workspace_close", { path }),
  listWorkspaces: () => call<WorkspaceSummary[]>("workspace_list"),

  // ---------------- 仓库管理中心与项目分组 ----------------
  catalogList: () => call<CatalogItemSummary[]>("catalog_list"),
  renameCatalogRepo: (path: string, alias: string | null) =>
    call<void>("catalog_repo_rename", { path, alias: alias ?? null }),
  setCatalogRepoGroup: (path: string, group: string) =>
    call<void>("catalog_repo_set_group", { path, group }),
  removeCatalogRepo: (path: string, deleteDiskFiles: boolean = false) =>
    call<void>("catalog_repo_remove", { path, deleteDiskFiles }),
  createCatalogGroup: (name: string) =>
    call<void>("catalog_group_create", { name }),
  renameCatalogGroup: (oldName: string, newName: string) =>
    call<void>("catalog_group_rename", { oldName, newName }),
  deleteCatalogGroup: (name: string) =>
    call<void>("catalog_group_delete", { name }),
  discoverWorktrees: (path: string) =>
    call<WorktreeInfo[]>("catalog_discover_worktrees", { path }),
  importWorktrees: (path: string, targetGroup: string) =>
    call<number>("catalog_import_worktrees", { path, targetGroup }),

  // ---------------- 原生窗口控制 ----------------
  windowMinimize: () => call<void>("window_minimize"),
  windowToggleMaximize: () => call<boolean>("window_toggle_maximize"),
  windowClose: () => call<void>("window_close"),
  windowIsMaximized: () => call<boolean>("window_is_maximized"),
  windowStartDragging: () => call<void>("window_start_dragging"),

  // ---------------- 文件目录与只读预览 ----------------
  readDir: (path?: string) =>
    call<FileEntry[]>("repo_read_dir", { path: path ?? null }),
  searchFiles: (query: string) =>
    call<FileSearchResult>("repo_search_files", { query }),
  searchContent: (options: ContentSearchOptions) =>
    call<ContentSearchResult>("repo_search_content", { options }),
  cancelContentSearch: () => call<void>("repo_cancel_content_search"),
  cancelHistorySearch: () => call<void>("repo_cancel_history_search"),
  readFile: (path: string) =>
    call<FilePreviewResult>("repo_read_file", { path }),

  // ---------------- 项目脚本自动解析与并发执行 ----------------
  discoverScripts: () => call<ScriptGroup[]>("repo_discover_scripts"),
  runScript: (request: ScriptItem) =>
    call<ScriptRunSession>("repo_run_script", { request }),
  stopScript: (runId: string) =>
    call<void>("repo_stop_script", { runId }),
  listRunningScripts: () =>
    call<ScriptRunSession[]>("repo_list_running_scripts"),

  // ---------------- 自动更新 ----------------
  checkUpdate: () => call<UpdateInfo | null>("update_check"),
  installUpdate: (onProgress: (p: UpdateProgress) => void) => {
    const channel = new Channel<UpdateProgress>();
    channel.onmessage = onProgress;
    return call<void>("update_install", { onEvent: channel });
  },
};
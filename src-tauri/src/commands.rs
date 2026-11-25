//! Tauri 命令层：全异步卸载至后台线程池，杜绝阻塞 GUI 主消息循环。

use std::sync::atomic::Ordering;
use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::git;
use crate::model::{
    CommitResult, FileDiff, FilePair, RepoStatus, StageArea,
};
use crate::state::AppState;

async fn run_blocking<F, T>(f: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::State(format!("后台任务执行异常: {e}")))?
}

/// 快照仓库路径并立即释放状态锁，在工作线程打开独立 `Repository` 执行只读或 CLI 操作（零锁竞争）。
async fn run_with_repo_unlocked<F, T>(app: tauri::AppHandle, f: F) -> AppResult<T>
where
    F: FnOnce(&git2::Repository) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    run_blocking(move || {
        let repo_path = app.state::<AppState>().active_repo_path()?;
        let repo = git2::Repository::open(&repo_path)?;
        f(&repo)
    })
    .await
}

async fn run_with_repo_mut_unlocked<F, T>(app: tauri::AppHandle, f: F) -> AppResult<T>
where
    F: FnOnce(&mut git2::Repository) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    run_blocking(move || {
        let repo_path = app.state::<AppState>().active_repo_path()?;
        let mut repo = git2::Repository::open(&repo_path)?;
        f(&mut repo)
    })
    .await
}

/// 快照活跃工作区根目录并立即释放锁，在工作线程执行目录读取、搜索与脚本发现。
async fn run_with_workdir<F, T>(app: tauri::AppHandle, f: F) -> AppResult<T>
where
    F: FnOnce(&std::path::Path) -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    run_blocking(move || {
        let workdir = app.state::<AppState>().active_workdir()?;
        f(&workdir)
    })
    .await
}

fn open_workspace_blocking(state: &AppState, path: String) -> AppResult<RepoStatus> {
    let repo = git::discover(&path)?;
    let workdir = repo
        .workdir()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .ok_or(AppError::NoRepo)?;

    let status = git::read_status(&repo)?;
    state.open_workspace(workdir, repo)?;
    Ok(status)
}

/// 打开仓库（自动向上发现），并加入工作区管理设为当前活跃。
#[tauri::command]
pub async fn repo_open(app: tauri::AppHandle, path: String) -> AppResult<RepoStatus> {
    workspace_open(app, path).await
}

// ---------------------------------------------------------------------------
// 多工作区管理
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn workspace_open(app: tauri::AppHandle, path: String) -> AppResult<RepoStatus> {
    run_blocking(move || open_workspace_blocking(&app.state::<AppState>(), path)).await
}

#[tauri::command]
pub async fn workspace_switch(app: tauri::AppHandle, path: String) -> AppResult<RepoStatus> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        if !state.is_workspace_open(&path) {
            // 如果该工作区尚未在多工作区列表中打开，自动打开并设为活跃
            return open_workspace_blocking(&state, path);
        }
        state.switch_workspace(&path)?;
        let repo_path = state.active_repo_path()?;
        let repo = git2::Repository::open(&repo_path)?;
        git::read_status(&repo)
    })
    .await
}

#[tauri::command]
pub async fn workspace_close(
    app: tauri::AppHandle,
    path: String,
) -> AppResult<Option<RepoStatus>> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let next_active = state.close_workspace(&path)?;
        match next_active {
            Some(_) => {
                let repo_path = state.active_repo_path()?;
                let repo = git2::Repository::open(&repo_path)?;
                git::read_status(&repo).map(Some)
            }
            None => Ok(None),
        }
    })
    .await
}

#[tauri::command]
pub async fn workspace_list(
    app: tauri::AppHandle,
) -> AppResult<Vec<crate::model::WorkspaceSummary>> {
    run_blocking(move || {
        app.state::<AppState>()
            .list_summaries(|path, original_name, alias, group, is_active, repo| {
                let (branch, detached) = match repo.head() {
                    Ok(head) => {
                        let detached = repo.head_detached().unwrap_or(false);
                        let name = head.shorthand().map(|s| s.to_string());
                        (name, detached)
                    }
                    Err(_) => (None, false),
                };

                let has_changes = if let Ok(st) = git::read_status(repo) {
                    !st.staged.is_empty() || !st.unstaged.is_empty() || !st.untracked.is_empty()
                } else {
                    false
                };

                let display_name = alias.unwrap_or(original_name).to_string();
                let project_name = group
                    .filter(|g| !g.trim().is_empty())
                    .unwrap_or(original_name)
                    .to_string();

                crate::model::WorkspaceSummary {
                    path: path.to_string(),
                    name: display_name,
                    project_name,
                    original_name: original_name.to_string(),
                    alias: alias.map(|s| s.to_string()),
                    group: group.map(|s| s.to_string()),
                    branch,
                    detached,
                    is_active,
                    has_changes,
                }
            })
    })
    .await
}

// ---------------------------------------------------------------------------
// 仓库统一管理中心与分组命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn catalog_list(
    app: tauri::AppHandle,
) -> AppResult<Vec<crate::model::CatalogItemSummary>> {
    run_blocking(move || app.state::<AppState>().get_catalog_summaries()).await
}

#[tauri::command]
pub async fn catalog_repo_rename(
    path: String,
    alias: Option<String>,
    app: tauri::AppHandle,
) -> AppResult<()> {
    run_blocking(move || app.state::<AppState>().rename_catalog_repo(&path, alias)).await
}

#[tauri::command]
pub async fn catalog_repo_set_group(
    path: String,
    group: String,
    app: tauri::AppHandle,
) -> AppResult<()> {
    run_blocking(move || app.state::<AppState>().set_catalog_repo_group(&path, &group)).await
}

#[tauri::command]
pub async fn catalog_repo_remove(
    path: String,
    delete_disk_files: Option<bool>,
    app: tauri::AppHandle,
) -> AppResult<()> {
    run_blocking(move || {
        app.state::<AppState>()
            .remove_catalog_repo(&path, delete_disk_files.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn catalog_group_create(name: String, app: tauri::AppHandle) -> AppResult<()> {
    run_blocking(move || app.state::<AppState>().create_catalog_group(&name)).await
}

#[tauri::command]
pub async fn catalog_group_rename(
    old_name: String,
    new_name: String,
    app: tauri::AppHandle,
) -> AppResult<()> {
    run_blocking(move || {
        app.state::<AppState>()
            .rename_catalog_group(&old_name, &new_name)
    })
    .await
}

#[tauri::command]
pub async fn catalog_group_delete(name: String, app: tauri::AppHandle) -> AppResult<()> {
    run_blocking(move || app.state::<AppState>().delete_catalog_group(&name)).await
}

#[tauri::command]
pub async fn catalog_discover_worktrees(
    path: String,
) -> AppResult<Vec<crate::model::WorktreeInfo>> {
    run_blocking(move || crate::catalog::discover_worktrees(&path)).await
}

#[tauri::command]
pub async fn catalog_import_worktrees(
    path: String,
    target_group: String,
    app: tauri::AppHandle,
) -> AppResult<usize> {
    run_blocking(move || {
        app.state::<AppState>()
            .import_worktrees_to_group(&path, &target_group)
    })
    .await
}

/// 在给定目录向上发现仓库，不改变当前打开状态（用于“这个目录是不是仓库”探测）。
#[tauri::command]
pub async fn repo_discover(path: String) -> AppResult<Option<String>> {
    run_blocking(move || match git::discover(&path) {
        Ok(repo) => Ok(repo
            .workdir()
            .map(|p| p.to_string_lossy().replace('\\', "/"))),
        Err(_) => Ok(None),
    })
    .await
}

/// 读取当前仓库状态。
#[tauri::command]
pub async fn repo_status(app: tauri::AppHandle) -> AppResult<RepoStatus> {
    run_with_repo_unlocked(app, git::read_status).await
}

/// 读取单文件 diff。
#[tauri::command]
pub async fn repo_diff_file(
    app: tauri::AppHandle,
    path: String,
    area: StageArea,
) -> AppResult<FileDiff> {
    run_with_repo_unlocked(app, move |repo| git::read_file_diff(repo, &path, area)).await
}

/// 读取工作区单文件前后完整内容（FilePair），供统一的 SideBySideDiff 渲染。
#[tauri::command]
pub async fn repo_workdir_file_pair(
    app: tauri::AppHandle,
    path: String,
    area: StageArea,
) -> AppResult<FilePair> {
    run_with_repo_unlocked(app, move |repo| git::read_workdir_file_pair(repo, &path, area)).await
}

#[tauri::command]
pub async fn repo_stage_file(app: tauri::AppHandle, path: String) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::stage_file(repo, &path)).await
}

#[tauri::command]
pub async fn repo_unstage_file(app: tauri::AppHandle, path: String) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::unstage_file(repo, &path)).await
}

#[tauri::command]
pub async fn repo_discard_file(
    app: tauri::AppHandle,
    path: String,
    area: StageArea,
) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::discard_file(repo, &path, area)).await
}

#[tauri::command]
pub async fn repo_stage_paths(app: tauri::AppHandle, paths: Vec<String>) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::stage_paths(repo, &paths)).await
}

#[tauri::command]
pub async fn repo_unstage_paths(app: tauri::AppHandle, paths: Vec<String>) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::unstage_paths(repo, &paths)).await
}

#[tauri::command]
pub async fn repo_discard_paths(app: tauri::AppHandle, paths: Vec<String>) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::discard_paths(repo, &paths)).await
}

#[tauri::command]
pub async fn repo_clean_untracked_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::clean_untracked_paths(repo, &paths)).await
}

#[tauri::command]
pub async fn repo_add_to_gitignore(app: tauri::AppHandle, pattern: String) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::add_to_gitignore(repo, &pattern)).await
}

#[tauri::command]
pub async fn repo_stage_hunk(
    app: tauri::AppHandle,
    path: String,
    hunk_index: usize,
) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::stage_hunk(repo, &path, hunk_index)).await
}

#[tauri::command]
pub async fn repo_unstage_hunk(
    app: tauri::AppHandle,
    path: String,
    hunk_index: usize,
) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::unstage_hunk(repo, &path, hunk_index)).await
}

#[tauri::command]
pub async fn repo_discard_hunk(
    app: tauri::AppHandle,
    path: String,
    hunk_index: usize,
) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| git::discard_hunk(repo, &path, hunk_index)).await
}

#[tauri::command]
pub async fn repo_commit(app: tauri::AppHandle, message: String) -> AppResult<CommitResult> {
    run_with_repo_unlocked(app, move |repo| git::commit(repo, &message)).await
}

#[tauri::command]
pub async fn repo_amend(app: tauri::AppHandle, message: String) -> AppResult<CommitResult> {
    run_with_repo_unlocked(app, move |repo| git::amend(repo, &message)).await
}

// ---------------------------------------------------------------------------
// 提交历史
// ---------------------------------------------------------------------------

/// 读取提交历史（分页 + 取消令牌）。`limit` 默认由前端传入，`branch` 可选指定分支范围，`query` 可选全历史过滤关键词。
#[tauri::command]
pub async fn repo_history(
    app: tauri::AppHandle,
    limit: usize,
    skip: usize,
    branch: Option<String>,
    query: Option<String>,
) -> AppResult<crate::model::CommitPage> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let token = state.next_history_search_token();
        let repo_path = state.active_repo_path()?;
        let gen_arc = state.history_search_gen.clone();
        let repo = git2::Repository::open(&repo_path)?;
        crate::history::read_history_cancellable(
            &repo,
            limit,
            skip,
            branch.as_deref(),
            query.as_deref(),
            move || gen_arc.load(Ordering::Relaxed) != token,
        )
    })
    .await
}

#[tauri::command]
pub async fn repo_cancel_history_search(app: tauri::AppHandle) -> AppResult<()> {
    app.state::<AppState>().cancel_history_search();
    Ok(())
}

/// 读取单个提交的详情。
#[tauri::command]
pub async fn repo_commit_detail(
    app: tauri::AppHandle,
    oid: String,
) -> AppResult<crate::model::CommitDetail> {
    run_with_repo_unlocked(app, move |repo| crate::history::read_commit_detail(repo, &oid)).await
}

/// 读取某个提交中某个文件的 diff。
#[tauri::command]
pub async fn repo_commit_file_diff(
    app: tauri::AppHandle,
    oid: String,
    path: String,
) -> AppResult<crate::model::FileDiff> {
    run_with_repo_unlocked(app, move |repo| {
        crate::history::read_commit_file_diff(repo, &oid, &path)
    })
    .await
}

/// 读取某个提交中某个文件的「修改前 / 修改后」完整内容（VS Code 式全文对比）。
#[tauri::command]
pub async fn repo_commit_file_pair(
    app: tauri::AppHandle,
    oid: String,
    path: String,
) -> AppResult<crate::model::FilePair> {
    run_with_repo_unlocked(app, move |repo| {
        crate::history::read_file_pair(repo, &oid, &path)
    })
    .await
}

// ---------------------------------------------------------------------------
// 分支管理
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn repo_branches(
    app: tauri::AppHandle,
) -> AppResult<Vec<crate::model::BranchInfo>> {
    run_with_repo_unlocked(app, crate::operations::list_branches).await
}

#[tauri::command]
pub async fn repo_branch_create(
    app: tauri::AppHandle,
    name: String,
    target_oid: Option<String>,
) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::create_branch(repo, &name, target_oid.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn repo_branch_checkout(
    app: tauri::AppHandle,
    name: String,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::checkout_branch(repo, &name)
    })
    .await
}

#[tauri::command]
pub async fn repo_branch_delete(
    app: tauri::AppHandle,
    name: String,
    force: bool,
    delete_remote: Option<bool>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::delete_branch(repo, &name, force, delete_remote.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn repo_branch_rename(
    app: tauri::AppHandle,
    old_name: String,
    new_name: String,
) -> AppResult<()> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::rename_branch(repo, &old_name, &new_name)
    })
    .await
}

// ---------------------------------------------------------------------------
// 远程网络同步
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn repo_remotes(
    app: tauri::AppHandle,
) -> AppResult<Vec<crate::model::RemoteInfo>> {
    run_with_repo_unlocked(app, crate::operations::list_remotes).await
}

#[tauri::command]
pub async fn repo_fetch(
    app: tauri::AppHandle,
    remote: Option<String>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::fetch(repo, remote.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn repo_pull(
    app: tauri::AppHandle,
    remote: Option<String>,
    branch: Option<String>,
    rebase: Option<bool>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::pull(
            repo,
            remote.as_deref(),
            branch.as_deref(),
            rebase.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn repo_undo_commit(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::undo_commit).await
}

#[tauri::command]
pub async fn repo_sync(app: tauri::AppHandle) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::sync).await
}

#[tauri::command]
pub async fn repo_discard_all_unstaged(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::discard_all_unstaged).await
}

#[tauri::command]
pub async fn repo_unstage_all(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::unstage_all).await
}

#[tauri::command]
pub async fn repo_discard_all_changes(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::discard_all_changes).await
}

#[tauri::command]
pub async fn repo_clean_untracked(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::clean_untracked).await
}

#[tauri::command]
pub async fn repo_abort_merge(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::abort_merge).await
}

#[tauri::command]
pub async fn repo_abort_rebase(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::abort_rebase).await
}

#[tauri::command]
pub async fn repo_abort_cherry_pick(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::abort_cherry_pick).await
}

#[tauri::command]
pub async fn repo_push(
    app: tauri::AppHandle,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force: bool,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::push(
            repo,
            remote.as_deref(),
            branch.as_deref(),
            set_upstream,
            force,
        )
    })
    .await
}

// ---------------------------------------------------------------------------
// 工作区储藏 (Stash)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn repo_stashes(
    app: tauri::AppHandle,
) -> AppResult<Vec<crate::model::StashInfo>> {
    run_with_repo_mut_unlocked(app, crate::operations::list_stashes).await
}

#[tauri::command]
pub async fn repo_stash_save(
    app: tauri::AppHandle,
    message: Option<String>,
    include_untracked: bool,
    keep_index: Option<bool>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::stash_save(
            repo,
            message.as_deref(),
            include_untracked,
            keep_index.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn repo_stash_pop(
    app: tauri::AppHandle,
    index: usize,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| crate::operations::stash_pop(repo, index)).await
}

#[tauri::command]
pub async fn repo_stash_apply(
    app: tauri::AppHandle,
    index: usize,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| crate::operations::stash_apply(repo, index)).await
}

#[tauri::command]
pub async fn repo_stash_drop(
    app: tauri::AppHandle,
    index: usize,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| crate::operations::stash_drop(repo, index)).await
}

#[tauri::command]
pub async fn repo_stash_clear(
    app: tauri::AppHandle,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, crate::operations::stash_clear).await
}

#[tauri::command]
pub async fn repo_stash_branch(
    app: tauri::AppHandle,
    branch_name: String,
    index: usize,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::stash_branch(repo, &branch_name, index)
    })
    .await
}

// ---------------------------------------------------------------------------
// 标签管理 (Tags)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn repo_tags(app: tauri::AppHandle) -> AppResult<Vec<crate::model::TagInfo>> {
    run_with_repo_unlocked(app, crate::operations::list_tags).await
}

#[tauri::command]
pub async fn repo_tag_create(
    app: tauri::AppHandle,
    name: String,
    target_oid: Option<String>,
    message: Option<String>,
    force: Option<bool>,
    push_remote: Option<bool>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::create_tag(
            repo,
            &name,
            target_oid.as_deref(),
            message.as_deref(),
            force.unwrap_or(false),
            push_remote.unwrap_or(false),
        )
    })
    .await
}

#[tauri::command]
pub async fn repo_tag_delete(
    app: tauri::AppHandle,
    name: String,
    delete_remote: Option<bool>,
    remote: Option<String>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::delete_tag(
            repo,
            &name,
            delete_remote.unwrap_or(false),
            remote.as_deref(),
        )
    })
    .await
}

#[tauri::command]
pub async fn repo_tag_push(
    app: tauri::AppHandle,
    name: String,
    remote: Option<String>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::push_tag(repo, &name, remote.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn repo_tag_push_all(
    app: tauri::AppHandle,
    remote: Option<String>,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| {
        crate::operations::push_all_tags(repo, remote.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn repo_tag_checkout(
    app: tauri::AppHandle,
    name: String,
) -> AppResult<crate::model::SyncResult> {
    run_with_repo_unlocked(app, move |repo| crate::operations::checkout_tag(repo, &name)).await
}

// ---------------------------------------------------------------------------
// 原生窗口控制 (Window Controls)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn window_minimize(window: tauri::Window) -> AppResult<()> {
    window.minimize()?;
    Ok(())
}

#[tauri::command]
pub fn window_toggle_maximize(window: tauri::Window) -> AppResult<bool> {
    if window.is_maximized()? {
        window.unmaximize()?;
        Ok(false)
    } else {
        window.maximize()?;
        Ok(true)
    }
}

#[tauri::command]
pub fn window_close(app: tauri::AppHandle, window: tauri::Window) -> AppResult<()> {
    app.state::<AppState>().visibility.set_visible(false);
    window.hide()?;
    Ok(())
}

#[tauri::command]
pub fn window_is_maximized(window: tauri::Window) -> AppResult<bool> {
    Ok(window.is_maximized()? || window.is_fullscreen()?)
}

#[tauri::command]
pub fn window_start_dragging(window: tauri::Window) -> AppResult<()> {
    window.start_dragging()?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 系统与外部工具联动 (System Actions)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn system_open_file(path: String) -> AppResult<()> {
    run_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let _ = std::process::Command::new("cmd")
                .args(["/C", "start", "", &path])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open").arg(&path).spawn();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn system_reveal_in_explorer(path: String) -> AppResult<()> {
    run_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            let p = std::path::Path::new(&path);
            let arg = if p.is_dir() {
                path.clone()
            } else {
                format!("/select,{}", path)
            };
            let _ = std::process::Command::new("explorer.exe")
                .arg(arg)
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open").args(["-R", &path]).spawn();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn system_open_terminal(path: String) -> AppResult<()> {
    run_blocking(move || {
        let p = std::path::Path::new(&path);
        let dir = if p.is_dir() {
            p.to_path_buf()
        } else {
            p.parent().unwrap_or(p).to_path_buf()
        };
        #[cfg(target_os = "windows")]
        {
            if std::process::Command::new("wt.exe")
                .args(["-d", dir.to_str().unwrap_or(".")])
                .spawn()
                .is_err()
            {
                let _ = std::process::Command::new("powershell.exe")
                    .current_dir(&dir)
                    .spawn();
            }
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open")
                .args(["-a", "Terminal", dir.to_str().unwrap_or(".")])
                .spawn();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("x-terminal-emulator")
                .current_dir(&dir)
                .spawn();
        }
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// 工作区文件目录浏览与只读预览
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_markdown: bool,
    pub is_image: bool,
    pub size: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileSearchResult {
    pub matches: Vec<FileEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FilePreviewResult {
    pub path: String,
    pub name: String,
    pub is_binary: bool,
    pub is_image: bool,
    pub is_markdown: bool,
    pub mime_type: Option<String>,
    pub text_content: Option<String>,
    pub base64_content: Option<String>,
    pub size: u64,
    pub line_count: Option<usize>,
}

pub(crate) fn is_markdown_extension(ext: &str) -> bool {
    ext.eq_ignore_ascii_case("md")
        || ext.eq_ignore_ascii_case("markdown")
        || ext.eq_ignore_ascii_case("mdown")
}

pub(crate) fn is_image_extension(ext: &str) -> bool {
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "ico" | "bmp" | "avif"
    )
}

fn guess_image_mime(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "image/png",
    }
}

fn to_base64(bytes: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut buf = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = if chunk.len() > 1 { chunk[1] } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] } else { 0 };
        buf.push(CHARSET[(b0 >> 2) as usize] as char);
        buf.push(CHARSET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            buf.push(CHARSET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            buf.push('=');
        }
        if chunk.len() > 2 {
            buf.push(CHARSET[(b2 & 0x3f) as usize] as char);
        } else {
            buf.push('=');
        }
    }
    buf
}

fn build_file_entry(
    workdir: &std::path::Path,
    entry: &std::fs::DirEntry,
) -> AppResult<Option<(FileEntry, std::fs::FileType)>> {
    let name = entry.file_name().to_string_lossy().to_string();
    if name == ".git" {
        return Ok(None);
    }

    let file_type = entry.file_type()?;
    let is_dir = file_type.is_dir();
    let metadata = entry.metadata().ok();
    let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);

    let ext = std::path::Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let is_markdown = !is_dir && is_markdown_extension(ext);
    let is_image = !is_dir && is_image_extension(ext);

    let abs_path = entry.path();
    let rel_path = match abs_path.strip_prefix(workdir) {
        Ok(p) => p.to_string_lossy().replace('\\', "/"),
        Err(_) => name.clone(),
    };

    Ok(Some((
        FileEntry {
            name,
            path: rel_path,
            is_dir,
            is_markdown,
            is_image,
            size,
        },
        file_type,
    )))
}

fn sort_file_entries(list: &mut [FileEntry]) {
    list.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
}

/// 读取工作区指定相对目录下的所有文件条目（内部核心逻辑，供单元测试与命令调用）。
pub fn read_dir_internal(
    workdir: &std::path::Path,
    path: Option<&str>,
) -> AppResult<Vec<FileEntry>> {
    let target = if let Some(sub) = path.filter(|s| !s.trim().is_empty()) {
        let rel = std::path::Path::new(sub);
        for c in rel.components() {
            if let std::path::Component::ParentDir = c {
                return Err(crate::error::AppError::InvalidPath(
                    "Parent directory traversal not allowed".into(),
                ));
            }
        }
        workdir.join(rel)
    } else {
        workdir.to_path_buf()
    };

    if !target.exists() || !target.is_dir() {
        return Err(crate::error::AppError::InvalidPath(format!(
            "Directory does not exist: {}",
            target.to_string_lossy()
        )));
    }

    // 校验目标路径未脱离工作区
    let canon_workdir = workdir.canonicalize()?;
    let canon_target = target.canonicalize()?;
    if !canon_target.starts_with(&canon_workdir) {
        return Err(crate::error::AppError::InvalidPath(
            "Target directory is outside workspace".into(),
        ));
    }

    let entries = std::fs::read_dir(&target)?;
    let mut list = Vec::new();

    for entry in entries.flatten() {
        if let Some((item, _)) = build_file_entry(workdir, &entry)? {
            list.push(item);
        }
    }

    sort_file_entries(&mut list);

    Ok(list)
}

/// 判断搜索词是否直接命中条目自身（避免仅命中父目录前缀导致子孙节点全部被误标命中）。
fn matches_search_query(item: &FileEntry, q_lower: &str, has_slash: bool) -> bool {
    let name_lower = item.name.to_lowercase();
    if !has_slash {
        return name_lower.contains(q_lower);
    }
    let path_lower = item.path.to_lowercase();
    let prefix_len = path_lower.len().saturating_sub(name_lower.len());
    path_lower
        .match_indices(q_lower)
        .any(|(idx, _)| idx + q_lower.len() > prefix_len)
}

fn should_skip_search_descent(dir_path: &std::path::Path, name: &str) -> bool {
    matches!(
        name,
        "node_modules" | ".pnpm-store" | "__pycache__" | ".venv" | ".next" | ".nuxt" | ".turbo"
    ) || dir_path.join("CACHEDIR.TAG").exists()
}

/// 递归搜索工作区中匹配名称或路径片段的目录与文件（最少 3 个字符，广度优先保障浅层优先）。
#[cfg_attr(not(test), allow(dead_code))]
pub fn search_files_internal(
    workdir: &std::path::Path,
    query: &str,
    max_results: usize,
) -> AppResult<FileSearchResult> {
    search_files_cancellable(workdir, query, max_results, || false)
}

/// 支持取消回调的工作区文件/目录广度优先检索。
pub fn search_files_cancellable<F>(
    workdir: &std::path::Path,
    query: &str,
    max_results: usize,
    mut should_cancel: F,
) -> AppResult<FileSearchResult>
where
    F: FnMut() -> bool,
{
    let normalized = query
        .trim()
        .replace('\\', "/")
        .trim_matches('/')
        .to_lowercase();
    if normalized.chars().count() < 3 || max_results == 0 {
        return Ok(FileSearchResult {
            matches: Vec::new(),
            truncated: false,
        });
    }

    if !workdir.exists() || !workdir.is_dir() {
        return Err(crate::error::AppError::InvalidPath(format!(
            "Workspace directory does not exist: {}",
            workdir.to_string_lossy()
        )));
    }

    const MAX_DEPTH: usize = 32;
    const MAX_VISITED: usize = 100_000;

    let has_slash = normalized.contains('/');
    let mut matches = Vec::new();
    let mut truncated = false;
    let mut visited = 0usize;
    let mut queue = std::collections::VecDeque::new();
    queue.push_back((workdir.to_path_buf(), 0usize));

    while let Some((dir, depth)) = queue.pop_front() {
        if should_cancel() {
            return Ok(FileSearchResult {
                matches: Vec::new(),
                truncated: false,
            });
        }
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };

        let mut level_items: Vec<(FileEntry, std::path::PathBuf, bool)> = Vec::new();
        for entry in read.flatten() {
            visited += 1;
            if visited % 128 == 0 && should_cancel() {
                return Ok(FileSearchResult {
                    matches: Vec::new(),
                    truncated: false,
                });
            }
            if visited > MAX_VISITED {
                truncated = true;
                break;
            }
            let Ok(Some((item, file_type))) = build_file_entry(workdir, &entry) else {
                continue;
            };
            // 不跟踪符号链接目录，防止循环软链或越界访问
            let can_descend = item.is_dir
                && !file_type.is_symlink()
                && depth + 1 < MAX_DEPTH
                && !should_skip_search_descent(&entry.path(), &item.name);
            level_items.push((item, entry.path(), can_descend));
        }

        level_items.sort_by(|(a, _, _), (b, _, _)| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        for (item, full_path, can_descend) in level_items {
            if matches_search_query(&item, &normalized, has_slash) {
                matches.push(item);
                if matches.len() >= max_results {
                    truncated = true;
                    break;
                }
            }
            if can_descend {
                queue.push_back((full_path, depth + 1));
            }
        }

        if truncated {
            break;
        }
    }

    Ok(FileSearchResult { matches, truncated })
}

/// 读取工作区指定相对目录下的所有文件条目（文件夹排前，同级按名称字母排序，排除 .git）。
#[tauri::command]
pub async fn repo_read_dir(
    app: tauri::AppHandle,
    path: Option<String>,
) -> AppResult<Vec<FileEntry>> {
    run_with_workdir(app, move |workdir| read_dir_internal(workdir, path.as_deref())).await
}

/// 搜索工作区中匹配的目录与文件（要求至少 3 个有效字符）。
#[tauri::command]
pub async fn repo_search_files(
    app: tauri::AppHandle,
    query: String,
) -> AppResult<FileSearchResult> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let token = state.next_file_search_token();
        let workdir = state.active_workdir()?;
        let gen_arc = state.file_search_gen.clone();
        search_files_cancellable(&workdir, &query, 500, move || {
            gen_arc.load(Ordering::Relaxed) != token
        })
    })
    .await
}

/// 读取工作区指定相对文件的只读预览数据（内部核心逻辑）。
pub fn read_file_internal(
    workdir: &std::path::Path,
    path: &str,
) -> AppResult<FilePreviewResult> {
    let rel = std::path::Path::new(path);
    for c in rel.components() {
        if let std::path::Component::ParentDir = c {
            return Err(crate::error::AppError::InvalidPath(
                "Parent directory traversal not allowed".into(),
            ));
        }
    }

    let target = workdir.join(rel);
    if !target.exists() {
        return Err(crate::error::AppError::InvalidPath(format!(
            "File does not exist: {}",
            path
        )));
    }

    let metadata = target.metadata()?;
    if metadata.is_dir() {
        return Err(crate::error::AppError::InvalidPath(
            "Target is a directory, not a file".into(),
        ));
    }

    let canon_workdir = workdir.canonicalize()?;
    let canon_target = target.canonicalize()?;
    if !canon_target.starts_with(&canon_workdir) {
        return Err(crate::error::AppError::InvalidPath(
            "Target file is outside workspace".into(),
        ));
    }

    let size = metadata.len();
    let name = target
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let ext = std::path::Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let is_markdown = is_markdown_extension(ext);
    let is_image = is_image_extension(ext);
    let rel_path_clean = path.replace('\\', "/");

    // 图片文件处理
    if is_image {
        let mime = guess_image_mime(ext);
        if size > 25 * 1024 * 1024 {
            // 超大图片提示
            return Ok(FilePreviewResult {
                path: rel_path_clean,
                name,
                is_binary: true,
                is_image: true,
                is_markdown: false,
                mime_type: Some(mime.to_string()),
                text_content: None,
                base64_content: None,
                size,
                line_count: None,
            });
        }

        let bytes = std::fs::read(&target)?;
        let b64 = to_base64(&bytes);
        return Ok(FilePreviewResult {
            path: rel_path_clean,
            name,
            is_binary: false,
            is_image: true,
            is_markdown: false,
            mime_type: Some(mime.to_string()),
            text_content: None,
            base64_content: Some(b64),
            size,
            line_count: None,
        });
    }

    // 超大文本文件处理（> 5MB 视为大文件，避免内存与 UI 阻塞）
    const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
    if size > MAX_TEXT_BYTES {
        return Ok(FilePreviewResult {
            path: rel_path_clean,
            name,
            is_binary: true,
            is_image: false,
            is_markdown,
            mime_type: None,
            text_content: None,
            base64_content: None,
            size,
            line_count: None,
        });
    }

    let bytes = std::fs::read(&target)?;

    // 二进制启发式检测（首 8KB 是否包含 null byte）
    let check_len = bytes.len().min(8192);
    let has_null = bytes[..check_len].contains(&0);
    if has_null {
        return Ok(FilePreviewResult {
            path: rel_path_clean,
            name,
            is_binary: true,
            is_image: false,
            is_markdown,
            mime_type: None,
            text_content: None,
            base64_content: None,
            size,
            line_count: None,
        });
    }

    match String::from_utf8(bytes) {
        Ok(text) => {
            let line_count = text.lines().count();
            Ok(FilePreviewResult {
                path: rel_path_clean,
                name,
                is_binary: false,
                is_image: false,
                is_markdown,
                mime_type: Some("text/plain".into()),
                text_content: Some(text),
                base64_content: None,
                size,
                line_count: Some(line_count),
            })
        }
        Err(_) => Ok(FilePreviewResult {
            path: rel_path_clean,
            name,
            is_binary: true,
            is_image: false,
            is_markdown,
            mime_type: None,
            text_content: None,
            base64_content: None,
            size,
            line_count: None,
        }),
    }
}

/// 读取工作区指定相对文件的只读预览数据（文本、Base64 图片或二进制判定）。
#[tauri::command]
pub async fn repo_read_file(
    app: tauri::AppHandle,
    path: String,
) -> AppResult<FilePreviewResult> {
    run_with_workdir(app, move |workdir| read_file_internal(workdir, &path)).await
}

/// 在当前工作区全局搜索文件内容（对标 VS Code Search，多线程非阻塞 + 代际取消）。
#[tauri::command]
pub async fn repo_search_content(
    app: tauri::AppHandle,
    options: crate::content_search::ContentSearchOptions,
) -> AppResult<crate::content_search::ContentSearchResult> {
    run_blocking(move || {
        let state = app.state::<AppState>();
        let token = state.next_content_search_token();
        let workdir = state.active_workdir()?;
        let gen_arc = state.content_search_gen.clone();
        crate::content_search::search_content_cancellable(&workdir, &options, move || {
            gen_arc.load(Ordering::Relaxed) != token
        })
    })
    .await
}

#[tauri::command]
pub async fn repo_cancel_content_search(app: tauri::AppHandle) -> AppResult<()> {
    app.state::<AppState>().cancel_content_search();
    Ok(())
}

/// 自动发现当前工作区下主流语言/构建工具的可执行脚本列表。
#[tauri::command]
pub async fn repo_discover_scripts(
    app: tauri::AppHandle,
) -> AppResult<Vec<crate::project_scripts::ScriptGroup>> {
    run_with_workdir(app, crate::project_scripts::discover_scripts_internal).await
}

/// 启动执行工作区中的某个脚本（后台并发运行，通过 `script://output` 与 `script://exit` 推送状态）。
#[tauri::command]
pub async fn repo_run_script(
    app: tauri::AppHandle,
    request: crate::project_scripts::ScriptItem,
) -> AppResult<crate::script_runner::ScriptRunSession> {
    run_blocking(move || {
        let workdir = app.state::<AppState>().active_workdir()?;
        let app_clone = app.clone();
        app.state::<AppState>().script_runner.start_script(
            app_clone,
            &workdir,
            crate::script_runner::RunScriptRequest {
                script_id: request.id,
                name: request.name,
                cwd: request.cwd,
                display_command: request.display_command,
            },
        )
    })
    .await
}

/// 终止指定正在运行的脚本及其子进程树。
#[tauri::command]
pub async fn repo_stop_script(
    app: tauri::AppHandle,
    run_id: String,
) -> AppResult<()> {
    run_blocking(move || app.state::<AppState>().script_runner.stop_script(&run_id)).await
}

/// 获取当前正在运行中的所有脚本会话。
#[tauri::command]
pub async fn repo_list_running_scripts(
    app: tauri::AppHandle,
) -> AppResult<Vec<crate::script_runner::ScriptRunSession>> {
    run_blocking(move || Ok(app.state::<AppState>().script_runner.list_running())).await
}

//! 应用级共享状态：多工作区管理器。
//!
//! 支持同时打开多个仓库并维护活动工作区，
//! 既兼容原先默认针对当前激活仓库的操作（`with_repo`、`with_repo_mut`），
//! 也提供多工作区切换、打开、关闭与并发管理能力。

#![allow(dead_code)]

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use git2::Repository;

use crate::catalog::{
    discover_worktrees, extract_basename, force_remove_dir_all, normalize_path,
};
use crate::error::{AppError, AppResult};
use crate::git;
use crate::model::{CatalogItemSummary, RepositoryCatalog, WorkspaceSummary};
use crate::operations::run_git_cli;

pub struct WorkspaceEntry {
    pub path: String,
    pub name: String,
    pub repo: Repository,
}

#[derive(Default)]
pub struct WorkspaceManager {
    /// 当前活跃的工作区规范路径
    pub active_path: Option<String>,
    /// 已打开的工作区实例字典 (path -> entry)
    pub workspaces: HashMap<String, WorkspaceEntry>,
    /// 打开顺序，用于 Tab 标签排序
    pub order: Vec<String>,
}

/// 窗口可见性信号：窗口隐藏到系统托盘时降低后台轮询频率，恢复窗口时立刻唤醒采样。
pub struct WindowVisibilitySignal {
    visible: AtomicBool,
    wake_lock: Mutex<()>,
    wake_cv: Condvar,
}

impl Default for WindowVisibilitySignal {
    fn default() -> Self {
        Self {
            visible: AtomicBool::new(true),
            wake_lock: Mutex::new(()),
            wake_cv: Condvar::new(),
        }
    }
}

impl WindowVisibilitySignal {
    pub fn is_visible(&self) -> bool {
        self.visible.load(Ordering::Relaxed)
    }

    pub fn set_visible(&self, visible: bool) {
        if let Ok(_guard) = self.wake_lock.lock() {
            let prev = self.visible.swap(visible, Ordering::SeqCst);
            if visible && !prev {
                self.wake_cv.notify_all();
            }
        } else {
            self.visible.store(visible, Ordering::SeqCst);
        }
    }

    pub fn wait_interval(&self, visible_interval: Duration, hidden_interval: Duration) {
        if self.is_visible() {
            std::thread::sleep(visible_interval);
            return;
        }
        if let Ok(guard) = self.wake_lock.lock() {
            if self.is_visible() {
                return;
            }
            let _ = self.wake_cv.wait_timeout(guard, hidden_interval);
        } else {
            std::thread::sleep(hidden_interval);
        }
    }
}

pub struct AppState {
    manager: Mutex<WorkspaceManager>,
    pub catalog: Mutex<RepositoryCatalog>,
    pub catalog_path: Mutex<Option<PathBuf>>,
    pub script_runner: crate::script_runner::ScriptRunnerManager,
    pub content_search_gen: Arc<AtomicU64>,
    pub file_search_gen: Arc<AtomicU64>,
    pub history_search_gen: Arc<AtomicU64>,
    pub visibility: Arc<WindowVisibilitySignal>,
    /// 更新安装期间置位，放行 `RunEvent::ExitRequested` 的退出拦截
    /// （默认关闭主窗口只是隐藏到托盘，需显式允许才真正退出）。
    pub allow_exit: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        let path = crate::catalog::resolve_catalog_path(None);
        let catalog = RepositoryCatalog::load_from_file(&path);
        Self {
            manager: Mutex::new(WorkspaceManager::default()),
            catalog: Mutex::new(catalog),
            catalog_path: Mutex::new(Some(path)),
            script_runner: crate::script_runner::ScriptRunnerManager::default(),
            content_search_gen: Arc::new(AtomicU64::new(0)),
            file_search_gen: Arc::new(AtomicU64::new(0)),
            history_search_gen: Arc::new(AtomicU64::new(0)),
            visibility: Arc::new(WindowVisibilitySignal::default()),
            allow_exit: Arc::new(AtomicBool::new(false)),
        }
    }
}

/// 辅助：从规范化路径提取文件夹名称
fn extract_repo_name(path: &str) -> String {
    path.split('/')
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or(path)
        .to_string()
}

impl AppState {
    pub fn new_with_catalog(catalog: RepositoryCatalog, path: Option<PathBuf>) -> Self {
        Self {
            manager: Mutex::new(WorkspaceManager::default()),
            catalog: Mutex::new(catalog),
            catalog_path: Mutex::new(path),
            script_runner: crate::script_runner::ScriptRunnerManager::default(),
            content_search_gen: Arc::new(AtomicU64::new(0)),
            file_search_gen: Arc::new(AtomicU64::new(0)),
            history_search_gen: Arc::new(AtomicU64::new(0)),
            visibility: Arc::new(WindowVisibilitySignal::default()),
            allow_exit: Arc::new(AtomicBool::new(false)),
        }
    }

    /// 允许应用真正退出（更新安装前置条件；Windows 安装器会强制结束进程）。
    pub fn allow_exit(&self) {
        self.allow_exit.store(true, Ordering::SeqCst);
    }

    pub fn is_exit_allowed(&self) -> bool {
        self.allow_exit.load(Ordering::SeqCst)
    }

    pub fn next_content_search_token(&self) -> u64 {
        self.content_search_gen.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn cancel_content_search(&self) {
        self.content_search_gen.fetch_add(1, Ordering::SeqCst);
    }

    pub fn next_file_search_token(&self) -> u64 {
        self.file_search_gen.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn next_history_search_token(&self) -> u64 {
        self.history_search_gen.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn cancel_history_search(&self) {
        self.history_search_gen.fetch_add(1, Ordering::SeqCst);
    }

    /// 极短持锁快照当前活跃工作区的工作目录路径，立刻释放锁以供无锁 I/O 使用。
    pub fn active_workdir(&self) -> AppResult<PathBuf> {
        let guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;
        let active = guard.active_path.as_ref().ok_or(AppError::NoRepo)?;
        let entry = guard.workspaces.get(active).ok_or(AppError::NoRepo)?;
        entry
            .repo
            .workdir()
            .map(|p| p.to_path_buf())
            .ok_or(AppError::NoRepo)
    }

    /// 极短持锁快照当前活跃仓库的可打开路径（优先 workdir，其次 gitdir）。
    pub fn active_repo_path(&self) -> AppResult<PathBuf> {
        let guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;
        let active = guard.active_path.as_ref().ok_or(AppError::NoRepo)?;
        let entry = guard.workspaces.get(active).ok_or(AppError::NoRepo)?;
        Ok(entry
            .repo
            .workdir()
            .unwrap_or_else(|| entry.repo.path())
            .to_path_buf())
    }

    pub fn stop_all_scripts(&self) {
        self.script_runner.stop_all();
    }

    /// 打开或新增工作区并设为当前活跃项（杜绝 manager 与 catalog 嵌套持锁）
    pub fn open_workspace(&self, path: String, repo: Repository) -> AppResult<()> {
        let norm_path = normalize_path(&path);
        let name = extract_repo_name(&path);

        {
            let mut guard = self
                .manager
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;

            if !guard.workspaces.contains_key(&path) {
                guard.order.push(path.clone());
            }

            guard.workspaces.insert(
                path.clone(),
                WorkspaceEntry {
                    path: path.clone(),
                    name,
                    repo,
                },
            );
            guard.active_path = Some(path);
        }

        // 先检查是否已有有效分组，缺失时在无锁状态下解析项目名称
        let has_group = self
            .catalog
            .lock()
            .ok()
            .and_then(|cat| {
                cat.repos
                    .iter()
                    .find(|r| r.path == norm_path)
                    .map(|r| r.group != "默认分组" && !r.group.trim().is_empty())
            })
            .unwrap_or(false);

        let resolved_group = if has_group {
            None
        } else {
            Some(crate::catalog::resolve_project_name(&norm_path))
        };

        // 自动将打开的仓库登记至持久化管理中心
        if let Ok(mut cat) = self.catalog.lock() {
            cat.touch_repo(&norm_path, None, resolved_group);
        }
        let _ = self.save_catalog();

        Ok(())
    }

    /// 检查指定路径的工作区是否已在内存中打开
    pub fn is_workspace_open(&self, raw_path: &str) -> bool {
        let norm = normalize_path(raw_path);
        let Ok(guard) = self.manager.lock() else {
            return false;
        };
        guard
            .workspaces
            .keys()
            .any(|k| normalize_path(k) == norm)
    }

    /// 切换当前活跃工作区
    pub fn switch_workspace(&self, raw_path: &str) -> AppResult<()> {
        let norm = normalize_path(raw_path);
        let mut guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;

        // 查找匹配的实际 key（考虑路径大小写与斜杠归一化）
        let actual_key = guard
            .workspaces
            .keys()
            .find(|k| normalize_path(k) == norm)
            .cloned();

        match actual_key {
            Some(key) => {
                guard.active_path = Some(key);
                Ok(())
            }
            None => Err(AppError::State(format!("workspace not open: {raw_path}"))),
        }
    }

    /// 关闭指定工作区。如果关闭的是当前活跃工作区，返回新的活跃工作区路径（若有）。
    pub fn close_workspace(&self, raw_path: &str) -> AppResult<Option<String>> {
        let norm = normalize_path(raw_path);
        let next_active = {
            let mut guard = self
                .manager
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;

            guard.workspaces.retain(|k, _| normalize_path(k) != norm);
            guard.order.retain(|p| normalize_path(p) != norm);

            let active_matches = guard
                .active_path
                .as_deref()
                .map(|p| normalize_path(p) == norm)
                .unwrap_or(false);

            if active_matches {
                guard.active_path = guard.order.last().cloned();
            }

            guard.active_path.clone()
        };

        self.script_runner.stop_for_workdir(raw_path);
        Ok(next_active)
    }

    /// 获取所有打开工作区的路径列表（按打开顺序）
    pub fn get_open_paths(&self) -> Vec<String> {
        let Ok(guard) = self.manager.lock() else {
            return Vec::new();
        };
        guard.order.clone()
    }

    /// 兼容现有接口：设置并替换为唯一或活跃的工作区
    pub fn set(&self, path: String, repo: Repository) -> AppResult<()> {
        self.open_workspace(path, repo)
    }

    /// 在当前活跃仓库上执行闭包；未打开仓库时返回 `NoRepo`。
    pub fn with_repo<T>(&self, f: impl FnOnce(&Repository) -> AppResult<T>) -> AppResult<T> {
        let guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;
        let active = guard.active_path.as_ref().ok_or(AppError::NoRepo)?;
        let entry = guard.workspaces.get(active).ok_or(AppError::NoRepo)?;
        f(&entry.repo)
    }

    /// 在当前活跃仓库上执行可变闭包。
    pub fn with_repo_mut<T>(&self, f: impl FnOnce(&mut Repository) -> AppResult<T>) -> AppResult<T> {
        let mut guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;
        let active = guard.active_path.clone().ok_or(AppError::NoRepo)?;
        let entry = guard.workspaces.get_mut(&active).ok_or(AppError::NoRepo)?;
        f(&mut entry.repo)
    }

    /// 在指定路径的工作区上执行闭包
    pub fn with_repo_at<T>(
        &self,
        path: &str,
        f: impl FnOnce(&Repository) -> AppResult<T>,
    ) -> AppResult<T> {
        let guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;
        let entry = guard.workspaces.get(path).ok_or(AppError::NoRepo)?;
        f(&entry.repo)
    }

    /// 当前活跃仓库的根目录。
    pub fn current_path(&self) -> AppResult<String> {
        let guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;
        guard.active_path.clone().ok_or(AppError::NoRepo)
    }

    /// 清空所有打开的工作区。
    pub fn clear(&self) -> AppResult<()> {
        let mut guard = self
            .manager
            .lock()
            .map_err(|_| AppError::State("state poisoned".into()))?;
        guard.workspaces.clear();
        guard.order.clear();
        guard.active_path = None;
        Ok(())
    }

    /// 获取工作区列表摘要
    pub fn list_summaries<F>(&self, mut summarize_fn: F) -> AppResult<Vec<WorkspaceSummary>>
    where
        F: FnMut(&str, &str, Option<&str>, Option<&str>, bool, &Repository) -> WorkspaceSummary,
    {
        let (items, active_opt) = {
            let guard = self
                .manager
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            let items: Vec<(String, String, PathBuf)> = guard
                .order
                .iter()
                .filter_map(|p| {
                    guard.workspaces.get(p).map(|entry| {
                        let open_target = entry
                            .repo
                            .workdir()
                            .unwrap_or_else(|| entry.repo.path())
                            .to_path_buf();
                        (entry.path.clone(), entry.name.clone(), open_target)
                    })
                })
                .collect();
            (items, guard.active_path.clone())
        };

        let meta_map: HashMap<String, (Option<String>, Option<String>)> = {
            let cat_guard = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            let mut map = HashMap::with_capacity(items.len());
            for (path, _, _) in &items {
                let norm_p = normalize_path(path);
                if let Some(cat_entry) = cat_guard.repos.iter().find(|r| r.path == norm_p) {
                    let grp = if cat_entry.group.trim().is_empty() {
                        None
                    } else {
                        Some(cat_entry.group.clone())
                    };
                    map.insert(norm_p, (cat_entry.alias.clone(), grp));
                }
            }
            map
        };

        let active = active_opt.as_deref();
        let mut list = Vec::with_capacity(items.len());
        for (path, original_name, open_target) in items {
            let is_active = active == Some(path.as_str());
            let norm_p = normalize_path(&path);
            let (alias, cat_group) = meta_map.get(&norm_p).cloned().unwrap_or((None, None));
            let group_owned = cat_group.unwrap_or_else(|| crate::catalog::resolve_project_name(&norm_p));

            if let Ok(repo) = Repository::open(&open_target) {
                list.push(summarize_fn(
                    &path,
                    &original_name,
                    alias.as_deref(),
                    Some(&group_owned),
                    is_active,
                    &repo,
                ));
            } else {
                let display_name = alias.clone().unwrap_or_else(|| original_name.clone());
                list.push(WorkspaceSummary {
                    path,
                    name: display_name,
                    project_name: group_owned.clone(),
                    original_name,
                    alias,
                    group: Some(group_owned),
                    branch: None,
                    detached: false,
                    is_active,
                    has_changes: false,
                });
            }
        }

        Ok(list)
    }

    // ---------------------------------------------------------------------------
    // 仓库管理中心（Catalog）操作
    // ---------------------------------------------------------------------------

    /// 在应用启动完成后绑定正式的应用配置路径
    pub fn init_catalog_path(&self, app: &tauri::AppHandle) {
        let path = crate::catalog::resolve_catalog_path(Some(app));
        let cat = RepositoryCatalog::load_from_file(&path);
        if let Ok(mut c) = self.catalog.lock() {
            *c = cat;
        }
        if let Ok(mut p) = self.catalog_path.lock() {
            *p = Some(path);
        }
    }

    /// 保存仓库清单至配置文件（拷贝快照后在无锁状态下写盘）
    pub fn save_catalog(&self) -> AppResult<()> {
        let snapshot = {
            let cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.clone()
        };
        let path_opt = {
            let path = self
                .catalog_path
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            path.clone()
        };
        if let Some(ref p) = path_opt {
            snapshot.save_to_file(p)?;
        }
        Ok(())
    }

    /// 获取全部仓库的完整清单摘要（严格分段短持锁后无锁探测仓库与 worktree，杜绝 AB-BA 死锁）
    pub fn get_catalog_summaries(&self) -> AppResult<Vec<CatalogItemSummary>> {
        let (open_norms, active_norm) = {
            let mgr = self
                .manager
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            let open_norms: HashSet<String> = mgr
                .workspaces
                .keys()
                .map(|k| normalize_path(k))
                .collect();
            let active_norm = mgr.active_path.as_ref().map(|p| normalize_path(p));
            (open_norms, active_norm)
        };

        let repos = {
            let cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.repos.clone()
        };

        let mut result = Vec::with_capacity(repos.len());
        for repo in &repos {
            let original_name = extract_basename(&repo.path);
            let display_name = repo.alias.clone().unwrap_or_else(|| original_name.clone());
            let is_open = open_norms.contains(&repo.path);
            let is_active = active_norm.as_deref() == Some(&repo.path);

            let (branch, has_changes) = if let Ok(r) = git2::Repository::open(&repo.path) {
                let b = r
                    .head()
                    .ok()
                    .and_then(|h| h.shorthand().map(|s| s.to_string()));
                let ch = if is_open {
                    git::read_status(&r)
                        .map(|st| {
                            !st.staged.is_empty()
                                || !st.unstaged.is_empty()
                                || !st.untracked.is_empty()
                        })
                        .unwrap_or(false)
                } else {
                    false
                };
                (b, ch)
            } else {
                (None, false)
            };

            let linked_worktrees = discover_worktrees(&repo.path).unwrap_or_default();
            let worktree_count = linked_worktrees.len();
            let is_worktree = worktree_count > 1;
            let is_main_worktree = linked_worktrees
                .iter()
                .find(|w| w.path == repo.path)
                .map(|w| w.is_main)
                .unwrap_or(false);

            result.push(CatalogItemSummary {
                path: repo.path.clone(),
                display_name,
                original_name,
                alias: repo.alias.clone(),
                group: repo.group.clone(),
                last_opened: repo.last_opened,
                is_pinned: repo.is_pinned,
                is_open,
                is_active,
                current_branch: branch,
                has_changes,
                worktree_count,
                is_worktree,
                is_main_worktree,
                linked_worktrees,
            });
        }

        Ok(result)
    }

    /// 重命名仓库别名
    pub fn rename_catalog_repo(&self, path: &str, alias: Option<String>) -> AppResult<()> {
        {
            let mut cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.rename_repo(path, alias)?;
        }
        self.save_catalog()
    }

    /// 调整仓库所属分组
    pub fn set_catalog_repo_group(&self, path: &str, group: &str) -> AppResult<()> {
        {
            let mut cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.set_repo_group(path, group)?;
        }
        self.save_catalog()
    }

    /// 从仓库清单中移除（可选是否连同硬盘物理文件一同删除）
    pub fn remove_catalog_repo(&self, raw_path: &str, delete_disk_files: bool) -> AppResult<()> {
        let norm_path = normalize_path(raw_path);

        // 1. 若当前在多工作区 Tab 或内存中打开，先彻底关闭以释放 git2 句柄与文件监视
        let _ = self.close_workspace(&norm_path);

        // 2. 若请求删除物理磁盘文件
        if delete_disk_files {
            // 探查是否属于派生的 Git Worktree
            if let Ok(worktrees) = discover_worktrees(&norm_path) {
                if let Some(main_wt) = worktrees.iter().find(|w| w.is_main) {
                    if normalize_path(&main_wt.path) != norm_path {
                        // 通过主仓库注销该工作树
                        let _ = run_git_cli(
                            &main_wt.path,
                            &["worktree", "remove", &norm_path, "--force"],
                        );
                    }
                }
            }
            // 物理删除目录（若依然存在）
            let p = PathBuf::from(&norm_path);
            if p.exists() {
                force_remove_dir_all(&p)
                    .map_err(|e| AppError::Io(e))?;
            }
        }

        // 3. 从 catalog 清单中移除
        {
            let mut cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.remove_repo(&norm_path)?;
        }
        self.save_catalog()
    }

    /// 新建分组
    pub fn create_catalog_group(&self, name: &str) -> AppResult<()> {
        {
            let mut cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.create_group(name)?;
        }
        self.save_catalog()
    }

    /// 重命名分组
    pub fn rename_catalog_group(&self, old_name: &str, new_name: &str) -> AppResult<()> {
        {
            let mut cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.rename_group(old_name, new_name)?;
        }
        self.save_catalog()
    }

    /// 删除分组
    pub fn delete_catalog_group(&self, name: &str) -> AppResult<()> {
        {
            let mut cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            cat.delete_group(name)?;
        }
        self.save_catalog()
    }

    /// 批量导入仓库的关联工作树到指定分组
    pub fn import_worktrees_to_group(&self, repo_path: &str, target_group: &str) -> AppResult<usize> {
        let worktrees = discover_worktrees(repo_path)?;
        let count = worktrees.len();
        {
            let mut cat = self
                .catalog
                .lock()
                .map_err(|_| AppError::State("state poisoned".into()))?;
            for wt in worktrees {
                cat.touch_repo(&wt.path, None, Some(target_group.to_string()));
            }
        }
        self.save_catalog()?;
        Ok(count)
    }
}

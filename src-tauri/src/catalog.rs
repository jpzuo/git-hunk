//! 仓库统一管理中心与项目分组（Repository Catalog）。
//!
//! 核心职责：
//! 1. 持久化记录用户打开过的所有仓库，并在应用生命周期内持久保存（JSON 格式）。
//! 2. 支持自定义显示别名（重命名）与多工作区分组（Groups）。
//! 3. 智能发现与批量导入 Git Worktree 多工作树，实现多工作区分组无缝就绪。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};
use crate::model::{
    CatalogGroup, CatalogRepo, RepositoryCatalog, WorktreeInfo,
};
use crate::operations::run_git_cli;

/// 路径规范化：反斜杠转正斜杠、移除末尾斜杠、统一驱动器盘符大小写
pub fn normalize_path(path: &str) -> String {
    let mut normalized = path.trim().replace('\\', "/");
    while normalized.ends_with('/') && normalized.len() > 1 {
        normalized.pop();
    }
    // Windows 盘符一致性（例如 C: -> c:）
    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        let drive = normalized.as_bytes()[0].to_ascii_lowercase() as char;
        normalized = format!("{}{}", drive, &normalized[1..]);
    }
    normalized
}

/// 从路径提取目录 basename
pub fn extract_basename(path: &str) -> String {
    let norm = normalize_path(path);
    norm.split('/')
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or(path)
        .to_string()
}

/// 获取指定仓库归属的主项目名称
/// 1. 若探测到关联的 Git Worktree 列表，优先取主工作树 (is_main == true) 所在目录的 basename
/// 2. 若无法探测到或非 Worktree，直接取当前仓库目录的 basename
pub fn resolve_project_name(repo_path: &str) -> String {
    if let Ok(worktrees) = discover_worktrees(repo_path) {
        if let Some(main_wt) = worktrees.iter().find(|w| w.is_main) {
            return extract_basename(&main_wt.path);
        }
        if let Some(first_wt) = worktrees.first() {
            return extract_basename(&first_wt.path);
        }
    }
    extract_basename(repo_path)
}

/// 递归将目录及其所有子项设置为可写（解决 Windows 下 .git/objects 等文件的只读属性导致 remove_dir_all 报错的问题）
fn set_writable_recursive(path: &Path) {
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                set_writable_recursive(&child);
            }
            if let Ok(metadata) = child.metadata() {
                let mut perms = metadata.permissions();
                if perms.readonly() {
                    perms.set_readonly(false);
                    let _ = fs::set_permissions(&child, perms);
                }
            }
        }
    }
    if let Ok(metadata) = path.metadata() {
        let mut perms = metadata.permissions();
        if perms.readonly() {
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

/// 强力删除目录及其所有内容（包括只读文件），若目录不存在则静默成功
pub fn force_remove_dir_all<P: AsRef<Path>>(path: P) -> std::io::Result<()> {
    let p = path.as_ref();
    if !p.exists() {
        return Ok(());
    }
    if let Err(_) = fs::remove_dir_all(p) {
        set_writable_recursive(p);
        fs::remove_dir_all(p)?;
    }
    Ok(())
}

/// 获取当前毫秒级时间戳
pub fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 计算持久化存储路径
pub fn resolve_catalog_path(app: Option<&tauri::AppHandle>) -> PathBuf {
    if let Some(app) = app {
        use tauri::Manager;
        if let Ok(dir) = app.path().app_config_dir() {
            return dir.join("repositories.json");
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata)
            .join("git-hunk")
            .join("repositories.json");
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        return PathBuf::from(home)
            .join(".git-hunk")
            .join("repositories.json");
    }
    PathBuf::from("repositories.json")
}

impl RepositoryCatalog {
    /// 从文件加载仓库清单，文件不存在或损坏时返回默认初始结构
    pub fn load_from_file(path: &Path) -> Self {
        if !path.exists() {
            return Self::default();
        }
        match fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<RepositoryCatalog>(&content) {
                Ok(mut catalog) => {
                    // 平滑迁移旧版遗留的 "默认分组"，将旧仓库迁移到以其项目名称命名的分组
                    for repo in &mut catalog.repos {
                        if repo.group == "默认分组" || repo.group.trim().is_empty() {
                            repo.group = resolve_project_name(&repo.path);
                        }
                    }
                    catalog.groups.retain(|g| g.name != "默认分组");
                    for repo in &catalog.repos {
                        if !catalog.groups.iter().any(|g| g.name == repo.group) {
                            catalog.groups.push(CatalogGroup {
                                name: repo.group.clone(),
                                order: catalog.groups.len(),
                            });
                        }
                    }
                    catalog
                }
                Err(e) => {
                    eprintln!("failed to parse catalog at {:?}: {}", path, e);
                    Self::default()
                }
            },
            Err(e) => {
                eprintln!("failed to read catalog file at {:?}: {}", path, e);
                Self::default()
            }
        }
    }

    /// 保存仓库清单到指定文件
    pub fn save_to_file(&self, path: &Path) -> AppResult<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::State(format!("failed to serialize catalog: {e}")))?;
        fs::write(path, json)?;
        Ok(())
    }

    /// 确保指定名称的分组存在
    pub fn ensure_group_exists(&mut self, name: &str) {
        let trimmed = name.trim();
        if !trimmed.is_empty() && !self.groups.iter().any(|g| g.name == trimmed) {
            self.groups.push(CatalogGroup {
                name: trimmed.to_string(),
                order: self.groups.len(),
            });
        }
    }

    /// 记录或刷新仓库状态（访问时调用）
    pub fn touch_repo(
        &mut self,
        raw_path: &str,
        alias: Option<String>,
        group: Option<String>,
    ) -> &CatalogRepo {
        let norm_path = normalize_path(raw_path);
        let now = current_timestamp_ms();

        let target_group = match group {
            Some(g) if !g.trim().is_empty() => g.trim().to_string(),
            _ => resolve_project_name(raw_path),
        };

        self.ensure_group_exists(&target_group);

        if let Some(idx) = self.repos.iter().position(|r| r.path == norm_path) {
            let repo = &mut self.repos[idx];
            repo.last_opened = now;
            if let Some(a) = alias {
                repo.alias = if a.trim().is_empty() {
                    None
                } else {
                    Some(a.trim().to_string())
                };
            }
            if repo.group == "默认分组" || repo.group.trim().is_empty() {
                repo.group = target_group;
            }
            &self.repos[idx]
        } else {
            let clean_alias = alias
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty());
            self.repos.push(CatalogRepo {
                path: norm_path,
                alias: clean_alias,
                group: target_group,
                last_opened: now,
                is_pinned: false,
            });
            self.repos.last().unwrap()
        }
    }

    /// 重命名仓库别名
    pub fn rename_repo(&mut self, raw_path: &str, alias: Option<String>) -> AppResult<()> {
        let norm_path = normalize_path(raw_path);
        let repo = self
            .repos
            .iter_mut()
            .find(|r| r.path == norm_path)
            .ok_or_else(|| AppError::State(format!("repository not in catalog: {raw_path}")))?;

        repo.alias = alias
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty());
        Ok(())
    }

    /// 设置仓库所属分组
    pub fn set_repo_group(&mut self, raw_path: &str, new_group: &str) -> AppResult<()> {
        let norm_path = normalize_path(raw_path);
        let group_name = new_group.trim();
        if group_name.is_empty() {
            return Err(AppError::State("group name cannot be empty".into()));
        }

        if !self.groups.iter().any(|g| g.name == group_name) {
            self.groups.push(CatalogGroup {
                name: group_name.to_string(),
                order: self.groups.len(),
            });
        }

        let repo = self
            .repos
            .iter_mut()
            .find(|r| r.path == norm_path)
            .ok_or_else(|| AppError::State(format!("repository not in catalog: {raw_path}")))?;

        repo.group = group_name.to_string();
        Ok(())
    }

    /// 从仓库清单中移除（不删除硬盘实际文件）
    pub fn remove_repo(&mut self, raw_path: &str) -> AppResult<()> {
        let norm_path = normalize_path(raw_path);
        let before_len = self.repos.len();
        self.repos.retain(|r| r.path != norm_path);
        if self.repos.len() == before_len {
            return Err(AppError::State(format!(
                "repository not in catalog: {raw_path}"
            )));
        }
        // 自动清理已经没有任何仓库的空分组
        self.groups.retain(|g| self.repos.iter().any(|r| r.group == g.name));
        Ok(())
    }

    /// 创建新分组
    pub fn create_group(&mut self, name: &str) -> AppResult<()> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(AppError::State("group name cannot be empty".into()));
        }
        if self.groups.iter().any(|g| g.name == trimmed) {
            return Err(AppError::State(format!("group already exists: {trimmed}")));
        }
        self.groups.push(CatalogGroup {
            name: trimmed.to_string(),
            order: self.groups.len(),
        });
        Ok(())
    }

    /// 重命名分组
    pub fn rename_group(&mut self, old_name: &str, new_name: &str) -> AppResult<()> {
        let old_clean = old_name.trim();
        let new_clean = new_name.trim();
        if new_clean.is_empty() {
            return Err(AppError::State("group name cannot be empty".into()));
        }
        if self.groups.iter().any(|g| g.name == new_clean) {
            return Err(AppError::State(format!("group already exists: {new_clean}")));
        }

        let group = self
            .groups
            .iter_mut()
            .find(|g| g.name == old_clean)
            .ok_or_else(|| AppError::State(format!("group not found: {old_clean}")))?;
        group.name = new_clean.to_string();

        for repo in &mut self.repos {
            if repo.group == old_clean {
                repo.group = new_clean.to_string();
            }
        }

        Ok(())
    }

    /// 删除分组（该分组下的仓库如果还有，自动按项目名归回各自项目组）
    pub fn delete_group(&mut self, name: &str) -> AppResult<()> {
        let trimmed = name.trim();
        let before_len = self.groups.len();
        self.groups.retain(|g| g.name != trimmed);
        if self.groups.len() == before_len {
            return Err(AppError::State(format!("group not found: {trimmed}")));
        }

        for repo in &mut self.repos {
            if repo.group == trimmed {
                repo.group = resolve_project_name(&repo.path);
            }
        }

        for repo in &self.repos {
            if !self.groups.iter().any(|g| g.name == repo.group) {
                self.groups.push(CatalogGroup {
                    name: repo.group.clone(),
                    order: self.groups.len(),
                });
            }
        }

        Ok(())
    }
}

/// 探测指定 Git 仓库的全部工作树（优先零子进程探测普通单仓库，仅存在 worktree 时调用 git CLI）
pub fn discover_worktrees(repo_path: &str) -> AppResult<Vec<WorktreeInfo>> {
    let norm = normalize_path(repo_path);
    let dot_git = Path::new(&norm).join(".git");
    if dot_git.is_dir() {
        let wt_dir = dot_git.join("worktrees");
        let has_linked_wt = wt_dir.is_dir()
            && fs::read_dir(&wt_dir)
                .map(|mut it| it.any(|e| e.ok().is_some_and(|d| d.path().is_dir())))
                .unwrap_or(false);
        if !has_linked_wt {
            if let Ok(repo) = git2::Repository::open(&norm) {
                let (head_oid, branch) = match repo.head() {
                    Ok(head) => {
                        let oid = head.target().map(|o| o.to_string()).unwrap_or_default();
                        let branch = if repo.head_detached().unwrap_or(false) {
                            Some("(detached)".to_string())
                        } else {
                            head.shorthand().map(|s| s.to_string())
                        };
                        (oid, branch)
                    }
                    Err(_) => (String::new(), None),
                };
                return Ok(vec![WorktreeInfo {
                    name: extract_basename(&norm),
                    path: norm,
                    head_oid,
                    branch,
                    is_main: true,
                }]);
            }
        }
    }

    let sync_res = match run_git_cli(&norm, &["worktree", "list", "--porcelain"]) {
        Ok(res) => res,
        Err(_) => return Ok(Vec::new()),
    };

    let mut list = Vec::new();
    let mut current_path: Option<String> = None;
    let mut current_oid: Option<String> = None;
    let mut current_branch: Option<String> = None;

    let flush_entry = |list: &mut Vec<WorktreeInfo>,
                       path: &mut Option<String>,
                       oid: &mut Option<String>,
                       branch: &mut Option<String>| {
        if let Some(p) = path.take() {
            let is_main = list.is_empty();
            let name = extract_basename(&p);
            list.push(WorktreeInfo {
                path: normalize_path(&p),
                name,
                head_oid: oid.take().unwrap_or_default(),
                branch: branch.take(),
                is_main,
            });
        }
    };

    for line in sync_res.stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush_entry(
                &mut list,
                &mut current_path,
                &mut current_oid,
                &mut current_branch,
            );
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("worktree ") {
            flush_entry(
                &mut list,
                &mut current_path,
                &mut current_oid,
                &mut current_branch,
            );
            current_path = Some(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("HEAD ") {
            current_oid = Some(rest.trim().to_string());
        } else if let Some(rest) = trimmed.strip_prefix("branch ") {
            let refname = rest.trim();
            let clean_b = refname
                .strip_prefix("refs/heads/")
                .unwrap_or(refname)
                .to_string();
            current_branch = Some(clean_b);
        } else if trimmed == "detached" {
            current_branch = Some("(detached)".to_string());
        }
    }

    flush_entry(
        &mut list,
        &mut current_path,
        &mut current_oid,
        &mut current_branch,
    );

    Ok(list)
}

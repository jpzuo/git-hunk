//! 多工作区生命周期、隔离性与并发切换测试。

use git2::Repository;

use crate::git;
use crate::operations::{create_branch, list_branches};
use crate::state::AppState;

fn init_repo(dir: &std::path::Path, user: &str) -> Repository {
    let repo = Repository::init(dir).expect("init repo");
    {
        let mut cfg = repo.config().expect("config");
        cfg.set_str("user.name", user).unwrap();
        cfg.set_str("user.email", &format!("{user}@example.com")).unwrap();
    }
    repo
}

fn workdir(repo: &Repository) -> std::path::PathBuf {
    repo.workdir().unwrap().to_path_buf()
}

fn tempdir(tag: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!(
        "git-hunk-ws-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn test_multi_workspace_lifecycle() {
    let dir_a = tempdir("repo-a");
    let dir_b = tempdir("repo-b");
    let dir_c = tempdir("repo-c");

    let repo_a = init_repo(&dir_a, "UserA");
    let repo_b = init_repo(&dir_b, "UserB");
    let repo_c = init_repo(&dir_c, "UserC");

    let path_a = repo_a.workdir().unwrap().to_string_lossy().replace('\\', "/");
    let path_b = repo_b.workdir().unwrap().to_string_lossy().replace('\\', "/");
    let path_c = repo_c.workdir().unwrap().to_string_lossy().replace('\\', "/");

    let state = AppState::default();

    // 1. 依次打开三个工作区
    state.open_workspace(path_a.clone(), repo_a).unwrap();
    assert_eq!(state.current_path().unwrap(), path_a);

    state.open_workspace(path_b.clone(), repo_b).unwrap();
    assert_eq!(state.current_path().unwrap(), path_b);

    state.open_workspace(path_c.clone(), repo_c).unwrap();
    assert_eq!(state.current_path().unwrap(), path_c);

    let paths = state.get_open_paths();
    assert_eq!(paths.len(), 3);
    assert_eq!(paths, vec![path_a.clone(), path_b.clone(), path_c.clone()]);

    // 2. 切换回 repo_a
    state.switch_workspace(&path_a).unwrap();
    assert_eq!(state.current_path().unwrap(), path_a);

    // 3. 关闭中间的 repo_b，活跃项应保持为 repo_a
    let next_active = state.close_workspace(&path_b).unwrap();
    assert_eq!(next_active, Some(path_a.clone()));
    assert_eq!(state.get_open_paths(), vec![path_a.clone(), path_c.clone()]);

    // 4. 关闭当前活跃的 repo_a，应自动回退切换到剩余的 repo_c
    let next_active = state.close_workspace(&path_a).unwrap();
    assert_eq!(next_active, Some(path_c.clone()));
    assert_eq!(state.current_path().unwrap(), path_c);

    // 5. 关闭最后一个 repo_c，活跃项变为 None
    let next_active = state.close_workspace(&path_c).unwrap();
    assert_eq!(next_active, None);
    assert!(state.get_open_paths().is_empty());
}

#[test]
fn test_multi_workspace_isolation() {
    let dir_1 = tempdir("repo-1");
    let dir_2 = tempdir("repo-2");

    let repo_1 = init_repo(&dir_1, "User1");
    let repo_2 = init_repo(&dir_2, "User2");

    // repo 1 初始提交
    std::fs::write(workdir(&repo_1).join("1.txt"), "repo 1").unwrap();
    git::stage_all(&repo_1).unwrap();
    git::commit(&repo_1, "init 1").unwrap();

    // repo 2 初始提交
    std::fs::write(workdir(&repo_2).join("2.txt"), "repo 2").unwrap();
    git::stage_all(&repo_2).unwrap();
    git::commit(&repo_2, "init 2").unwrap();

    let path_1 = repo_1.workdir().unwrap().to_string_lossy().replace('\\', "/");
    let path_2 = repo_2.workdir().unwrap().to_string_lossy().replace('\\', "/");

    let state = AppState::default();
    state.open_workspace(path_1.clone(), repo_1).unwrap();
    state.open_workspace(path_2.clone(), repo_2).unwrap();

    // 在当前活跃工作区 repo 2 上创建分支
    state.with_repo(|r| create_branch(r, "branch-only-in-2", None)).unwrap();

    // 验证 repo 2 存在该分支
    let branches_2 = state.with_repo(list_branches).unwrap();
    assert!(branches_2.iter().any(|b| b.name == "branch-only-in-2"));

    // 切换至 repo 1，验证 repo 1 绝不存在该分支
    state.switch_workspace(&path_1).unwrap();
    let branches_1 = state.with_repo(list_branches).unwrap();
    assert!(!branches_1.iter().any(|b| b.name == "branch-only-in-2"));
}

#[test]
fn state_no_lock_inversion_stress() {
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    let dir_1 = tempdir("stress-1");
    let dir_2 = tempdir("stress-2");
    let repo_1 = init_repo(&dir_1, "User1");
    let repo_2 = init_repo(&dir_2, "User2");

    std::fs::write(workdir(&repo_1).join("a.txt"), "1").unwrap();
    git::stage_all(&repo_1).unwrap();
    git::commit(&repo_1, "c1").unwrap();

    std::fs::write(workdir(&repo_2).join("b.txt"), "2").unwrap();
    git::stage_all(&repo_2).unwrap();
    git::commit(&repo_2, "c2").unwrap();

    let path_1 = repo_1.workdir().unwrap().to_string_lossy().replace('\\', "/");
    let path_2 = repo_2.workdir().unwrap().to_string_lossy().replace('\\', "/");

    let state = Arc::new(AppState::new_with_catalog(
        crate::model::RepositoryCatalog::default(),
        Some(dir_1.join("catalog.json")),
    ));
    state.open_workspace(path_1.clone(), repo_1).unwrap();
    state.open_workspace(path_2.clone(), repo_2).unwrap();

    let (tx, rx) = mpsc::channel();
    for worker_idx in 0..6 {
        let st = Arc::clone(&state);
        let p1 = path_1.clone();
        let p2 = path_2.clone();
        let tx = tx.clone();
        std::thread::spawn(move || {
            for i in 0..25 {
                let target = if (i + worker_idx) % 2 == 0 { &p1 } else { &p2 };
                let _ = st.switch_workspace(target);
                let _ = st.list_summaries(|path, orig, alias, group, is_active, r| {
                    let branch = r.head().ok().and_then(|h| h.shorthand().map(|s| s.to_string()));
                    crate::model::WorkspaceSummary {
                        path: path.to_string(),
                        name: alias.unwrap_or(orig).to_string(),
                        project_name: group.unwrap_or(orig).to_string(),
                        original_name: orig.to_string(),
                        alias: alias.map(|s| s.to_string()),
                        group: group.map(|s| s.to_string()),
                        branch,
                        detached: false,
                        is_active,
                        has_changes: false,
                    }
                });
                let _ = st.get_catalog_summaries();
                let _ = st.active_workdir();
                if let Ok(r) = git2::Repository::open(target) {
                    let _ = st.open_workspace(target.clone(), r);
                }
            }
            let _ = tx.send(());
        });
    }
    drop(tx);

    for _ in 0..6 {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("并发工作区与 Catalog 查询发生死锁或严重卡顿");
    }
}

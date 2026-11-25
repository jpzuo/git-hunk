//! 仓库管理中心与项目分组测试。

use std::fs;
use std::path::PathBuf;

use crate::catalog::{discover_worktrees, resolve_project_name};
use crate::model::RepositoryCatalog;
use crate::operations::run_git_cli;

fn tempdir(tag: &str) -> PathBuf {
    let base = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!(
        "git-hunk-test-{tag}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn test_catalog_lifecycle_and_grouping() {
    let mut catalog = RepositoryCatalog::default();

    // 1. 初始 groups 为空
    assert_eq!(catalog.groups.len(), 0);

    // 2. 添加仓库时自动提取项目名称作为分组名称（零手动配置）
    let r1 = catalog.touch_repo("C:\\projects\\app-frontend", None, None);
    assert_eq!(r1.path, "c:/projects/app-frontend");
    assert_eq!(r1.group, "app-frontend");
    assert!(r1.alias.is_none());
    assert_eq!(catalog.groups.len(), 1);
    assert_eq!(catalog.groups[0].name, "app-frontend");

    // 3. 重命名别名
    catalog
        .rename_repo("c:/projects/app-frontend", Some("前端主站".into()))
        .unwrap();
    assert_eq!(
        catalog.repos[0].alias.as_deref(),
        Some("前端主站")
    );

    // 4. 新建自定义分组并将仓库移动至新分组
    catalog.create_group("电商项目群").unwrap();
    assert_eq!(catalog.groups.len(), 2);

    catalog
        .set_repo_group("c:/projects/app-frontend", "电商项目群")
        .unwrap();
    assert_eq!(catalog.repos[0].group, "电商项目群");

    // 5. 自动创建不存在的分组
    catalog
        .set_repo_group("c:/projects/app-frontend", "新微服务组")
        .unwrap();
    assert_eq!(catalog.repos[0].group, "新微服务组");
    assert!(catalog.groups.iter().any(|g| g.name == "新微服务组"));

    // 6. 分组自由重命名联动
    catalog
        .rename_group("新微服务组", "核心中台群")
        .unwrap();
    assert_eq!(catalog.repos[0].group, "核心中台群");
    assert!(!catalog.groups.iter().any(|g| g.name == "新微服务组"));
    assert!(catalog.groups.iter().any(|g| g.name == "核心中台群"));

    // 7. 删除分组时仓库自动按项目名称回退
    catalog.delete_group("核心中台群").unwrap();
    assert_eq!(catalog.repos[0].group, "app-frontend");
    assert!(!catalog.groups.iter().any(|g| g.name == "核心中台群"));

    // 8. 移除仓库并自动清理空分组
    catalog
        .remove_repo("c:/projects/app-frontend")
        .unwrap();
    assert_eq!(catalog.repos.len(), 0);
    assert_eq!(catalog.groups.len(), 0);
}

#[test]
fn test_catalog_file_persistence() {
    let dir = tempdir("persistence");
    let file_path = dir.join("repositories.json");

    let mut catalog = RepositoryCatalog::default();
    catalog.create_group("测试分组").unwrap();
    catalog.touch_repo("D:\\work\\repo1", Some("别名1".into()), Some("测试分组".into()));

    // 保存到文件
    catalog.save_to_file(&file_path).unwrap();
    assert!(file_path.exists());

    // 从文件重新加载
    let loaded = RepositoryCatalog::load_from_file(&file_path);
    assert_eq!(loaded.groups.len(), 1);
    assert_eq!(loaded.repos.len(), 1);
    assert_eq!(loaded.repos[0].path, "d:/work/repo1");
    assert_eq!(loaded.repos[0].alias.as_deref(), Some("别名1"));
    assert_eq!(loaded.repos[0].group, "测试分组");
}

#[test]
fn test_legacy_default_group_migration() {
    let dir = tempdir("legacy-migration");
    let file_path = dir.join("repositories.json");

    // 模拟旧版本写入包含 "默认分组" 的 JSON
    let legacy_json = r#"{
        "groups": [
            { "name": "默认分组", "order": 0 }
        ],
        "repos": [
            {
                "path": "c:/work/legacy-app",
                "alias": null,
                "group": "默认分组",
                "last_opened": 1000,
                "is_pinned": false
            }
        ]
    }"#;
    fs::write(&file_path, legacy_json).unwrap();

    let loaded = RepositoryCatalog::load_from_file(&file_path);
    // "默认分组" 应被移除，仓库自动迁移到 "legacy-app" 分组
    assert!(!loaded.groups.iter().any(|g| g.name == "默认分组"));
    assert_eq!(loaded.repos[0].group, "legacy-app");
    assert!(loaded.groups.iter().any(|g| g.name == "legacy-app"));
}

#[test]
fn test_worktree_discovery_and_project_resolution() {
    let dir = tempdir("worktree");
    let main_repo_dir = dir.join("main_repo");
    fs::create_dir_all(&main_repo_dir).unwrap();

    // 初始化 git 仓库并做一次初始提交
    let repo = git2::Repository::init(&main_repo_dir).unwrap();
    let sig = git2::Signature::now("Tester", "tester@test.com").unwrap();
    let file_path = main_repo_dir.join("init.txt");
    fs::write(&file_path, "hello").unwrap();

    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("init.txt")).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "init commit", &tree, &[])
        .unwrap();

    // 此时仅有主工作树
    let wts = discover_worktrees(main_repo_dir.to_str().unwrap()).unwrap();
    assert_eq!(wts.len(), 1);
    assert!(wts[0].is_main);
    assert_eq!(
        resolve_project_name(main_repo_dir.to_str().unwrap()),
        "main_repo"
    );

    // 通过 git worktree add 新增一个 linked worktree
    let wt_dir = dir.join("feat_worktree");
    let res = run_git_cli(
        &main_repo_dir,
        &[
            "worktree",
            "add",
            "-b",
            "feature-test",
            wt_dir.to_str().unwrap(),
        ],
    );

    if res.is_ok() {
        let wts_after = discover_worktrees(main_repo_dir.to_str().unwrap()).unwrap();
        assert_eq!(wts_after.len(), 2);
        assert!(wts_after[0].is_main);
        assert!(!wts_after[1].is_main);
        assert_eq!(wts_after[1].branch.as_deref(), Some("feature-test"));
        assert_eq!(wts_after[1].name, "feat_worktree");

        // 从派生工作树路径解析项目名称，依然得到 "main_repo"
        assert_eq!(
            resolve_project_name(wt_dir.to_str().unwrap()),
            "main_repo"
        );
    }
}

#[test]
fn test_remove_repo_with_disk_deletion() {
    let dir = tempdir("disk-delete");
    let repo_dir = dir.join("temp_repo");
    fs::create_dir_all(&repo_dir).unwrap();
    fs::write(repo_dir.join("test.txt"), "hello").unwrap();

    let state = crate::state::AppState::new_with_catalog(
        RepositoryCatalog::default(),
        Some(dir.join("catalog.json")),
    );
    state.catalog.lock().unwrap().touch_repo(repo_dir.to_str().unwrap(), None, None);

    assert!(repo_dir.exists());
    assert_eq!(state.catalog.lock().unwrap().repos.len(), 1);

    // 物理删除
    state.remove_catalog_repo(repo_dir.to_str().unwrap(), true).unwrap();

    assert!(!repo_dir.exists());
    assert_eq!(state.catalog.lock().unwrap().repos.len(), 0);
    assert_eq!(state.catalog.lock().unwrap().groups.len(), 0);
}

#[test]
fn test_remove_worktree_with_disk_deletion() {
    let dir = tempdir("wt-delete");
    let main_repo_dir = dir.join("main_repo");
    fs::create_dir_all(&main_repo_dir).unwrap();

    let repo = git2::Repository::init(&main_repo_dir).unwrap();
    let sig = git2::Signature::now("Tester", "tester@test.com").unwrap();
    let file_path = main_repo_dir.join("init.txt");
    fs::write(&file_path, "hello").unwrap();

    let mut index = repo.index().unwrap();
    index.add_path(std::path::Path::new("init.txt")).unwrap();
    index.write().unwrap();
    let tree_id = index.write_tree().unwrap();
    let tree = repo.find_tree(tree_id).unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "init commit", &tree, &[])
        .unwrap();

    let wt_dir = dir.join("feat_worktree");
    let res = run_git_cli(
        &main_repo_dir,
        &[
            "worktree",
            "add",
            "-b",
            "feat-del",
            wt_dir.to_str().unwrap(),
        ],
    );

    if res.is_ok() {
        assert!(wt_dir.exists());

        let state = crate::state::AppState::new_with_catalog(
            RepositoryCatalog::default(),
            Some(dir.join("catalog.json")),
        );
        state.catalog.lock().unwrap().touch_repo(wt_dir.to_str().unwrap(), None, None);

        // 删除工作树，同时物理删除
        state.remove_catalog_repo(wt_dir.to_str().unwrap(), true).unwrap();

        assert!(!wt_dir.exists());
        assert_eq!(state.catalog.lock().unwrap().repos.len(), 0);

        // 验证主工作区检测到的工作树数量回到 1
        let wts = discover_worktrees(main_repo_dir.to_str().unwrap()).unwrap();
        assert_eq!(wts.len(), 1);
    }
}

#[test]
fn catalog_fast_non_worktree_detection() {
    let dir = tempdir("fast-wt");
    let repo_dir = dir.join("single-repo");
    std::fs::create_dir_all(&repo_dir).unwrap();
    let repo = git2::Repository::init(&repo_dir).unwrap();
    let mut sig_cfg = repo.config().unwrap();
    sig_cfg.set_str("user.name", "Test").unwrap();
    sig_cfg.set_str("user.email", "test@example.com").unwrap();
    std::fs::write(repo_dir.join("README.md"), "hello").unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("README.md")).unwrap();
    idx.write().unwrap();
    let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
    let sig = git2::Signature::now("Test", "test@example.com").unwrap();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();

    let wts = discover_worktrees(repo_dir.to_str().unwrap()).unwrap();
    assert_eq!(wts.len(), 1);
    assert!(wts[0].is_main);
    assert_eq!(wts[0].head_oid, oid.to_string());
    assert!(wts[0].branch.is_some());
}

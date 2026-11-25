//! 分支、Stash、Tag 扩展操作的集成测试。

use git2::Repository;

use crate::git;
use crate::operations::{
    checkout_branch, checkout_tag, create_branch, create_tag, delete_branch, delete_tag,
    list_branches, list_stashes, list_tags, rename_branch, stash_branch, stash_clear, stash_pop,
    stash_save,
};

fn init_repo(dir: &std::path::Path) -> Repository {
    let repo = Repository::init(dir).expect("init repo");
    {
        let mut cfg = repo.config().expect("config");
        cfg.set_str("user.name", "OpTest").unwrap();
        cfg.set_str("user.email", "op@example.com").unwrap();
    }
    repo
}

fn workdir(repo: &Repository) -> std::path::PathBuf {
    repo.workdir().unwrap().to_path_buf()
}

fn commit_all(repo: &Repository, msg: &str) -> String {
    git::stage_all(repo).unwrap();
    git::commit(repo, msg).unwrap().oid
}

fn tempdir(tag: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!(
        "git-hunk-op-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn branch_lifecycle() {
    let dir = tempdir("branch");
    let repo = init_repo(&dir);

    // 初始提交
    std::fs::write(workdir(&repo).join("init.txt"), "hello\n").unwrap();
    commit_all(&repo, "initial commit");

    // 1. 读取初始分支
    let branches = list_branches(&repo).unwrap();
    assert_eq!(branches.len(), 1);
    assert!(branches[0].is_head);
    let main_name = branches[0].name.clone();

    // 2. 创建新分支
    create_branch(&repo, "feature-x", None).unwrap();
    let branches_after = list_branches(&repo).unwrap();
    assert_eq!(branches_after.len(), 2);
    assert!(branches_after.iter().any(|b| b.name == "feature-x"));

    // 3. 重命名分支
    rename_branch(&repo, "feature-x", "feature-renamed").unwrap();
    let branches_renamed = list_branches(&repo).unwrap();
    assert!(branches_renamed.iter().any(|b| b.name == "feature-renamed"));
    assert!(!branches_renamed.iter().any(|b| b.name == "feature-x"));

    // 4. 切换到新分支
    checkout_branch(&repo, "feature-renamed").unwrap();
    let branches_switched = list_branches(&repo).unwrap();
    let active = branches_switched.iter().find(|b| b.is_head).unwrap();
    assert_eq!(active.name, "feature-renamed");

    // 5. 切换回原分支并删除 feature-renamed
    checkout_branch(&repo, &main_name).unwrap();
    delete_branch(&repo, "feature-renamed", false, false).unwrap();
    let branches_final = list_branches(&repo).unwrap();
    assert_eq!(branches_final.len(), 1);
}

#[test]
fn tag_lifecycle() {
    let dir = tempdir("tag");
    let repo = init_repo(&dir);

    std::fs::write(workdir(&repo).join("init.txt"), "tag test\n").unwrap();
    let oid = commit_all(&repo, "commit for tag");

    // 1. 创建轻量标签
    create_tag(&repo, "v0.1.0", Some(&oid), None, false, false).unwrap();

    // 2. 创建附注标签
    create_tag(
        &repo,
        "v1.0.0",
        Some(&oid),
        Some("first stable release"),
        false,
        false,
    )
    .unwrap();

    // 3. 读取标签列表
    let tags = list_tags(&repo).unwrap();
    assert_eq!(tags.len(), 2);

    let v1 = tags.iter().find(|t| t.name == "v1.0.0").unwrap();
    assert_eq!(v1.message.as_deref(), Some("first stable release"));
    assert_eq!(v1.target_oid, oid);

    // 4. 强制覆盖标签 (force = true)
    std::fs::write(workdir(&repo).join("init.txt"), "tag update\n").unwrap();
    let oid2 = commit_all(&repo, "commit 2 for tag overwrite");
    create_tag(
        &repo,
        "v1.0.0",
        Some(&oid2),
        Some("overwritten release"),
        true,
        false,
    )
    .unwrap();
    let tags_updated = list_tags(&repo).unwrap();
    let v1_updated = tags_updated.iter().find(|t| t.name == "v1.0.0").unwrap();
    assert_eq!(v1_updated.target_oid, oid2);
    assert_eq!(v1_updated.message.as_deref(), Some("overwritten release"));

    // 5. 检出标签 (checkout tag)
    let checkout_res = checkout_tag(&repo, "v1.0.0").unwrap();
    assert!(checkout_res.success);
    assert!(repo.head().unwrap().is_branch() == false, "检出标签后应处于游离头指针状态");

    // 6. 删除本地标签
    delete_tag(&repo, "v0.1.0", false, None).unwrap();
    let tags_after = list_tags(&repo).unwrap();
    assert_eq!(tags_after.len(), 1);
    assert_eq!(tags_after[0].name, "v1.0.0");
}

#[test]
fn stash_lifecycle() {
    let dir = tempdir("stash");
    let mut repo = init_repo(&dir);

    std::fs::write(workdir(&repo).join("file.txt"), "line 1\n").unwrap();
    commit_all(&repo, "base commit");

    // 修改文件
    std::fs::write(workdir(&repo).join("file.txt"), "line 1\nline 2 (modified)\n").unwrap();

    // 1. 储藏工作区
    stash_save(&repo, Some("wip on file"), false, false).unwrap();

    // 2. 检查工作区已干净
    let content_after_stash = std::fs::read_to_string(workdir(&repo).join("file.txt"))
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(content_after_stash, "line 1\n");

    // 3. 读取 stash 列表
    let stashes = list_stashes(&mut repo).unwrap();
    assert_eq!(stashes.len(), 1);
    assert!(stashes[0].message.contains("wip on file") || stashes[0].name.contains("wip on file"));

    // 4. Pop stash
    stash_pop(&repo, 0).unwrap();

    // 5. 检查修改已恢复
    let content_restored = std::fs::read_to_string(workdir(&repo).join("file.txt"))
        .unwrap()
        .replace("\r\n", "\n");
    assert_eq!(content_restored, "line 1\nline 2 (modified)\n");

    // 6. 检查 stash 列表已被清除
    let stashes_empty = list_stashes(&mut repo).unwrap();
    assert_eq!(stashes_empty.len(), 0);
}

#[test]
fn stash_clear_and_branch_lifecycle() {
    let dir = tempdir("stash-ext");
    let mut repo = init_repo(&dir);

    std::fs::write(workdir(&repo).join("file.txt"), "init\n").unwrap();
    commit_all(&repo, "init commit");

    // 1. 创建两个储藏
    std::fs::write(workdir(&repo).join("file.txt"), "init\nfirst mod\n").unwrap();
    stash_save(&repo, Some("stash one"), false, false).unwrap();

    std::fs::write(workdir(&repo).join("file.txt"), "init\nsecond mod\n").unwrap();
    stash_save(&repo, Some("stash two"), false, false).unwrap();

    let stashes = list_stashes(&mut repo).unwrap();
    assert_eq!(stashes.len(), 2);

    // 2. 测试基于 stash@{0} 检出新分支
    stash_branch(&repo, "feat-from-stash", 0).unwrap();
    let branches = list_branches(&repo).unwrap();
    let current_branch = branches.iter().find(|b| b.is_head).unwrap();
    assert_eq!(current_branch.name, "feat-from-stash");

    // 检出后 stash@{0} 应被自动丢弃，剩下 1 个 stash
    let stashes_after_branch = list_stashes(&mut repo).unwrap();
    assert_eq!(stashes_after_branch.len(), 1);

    // 3. 测试 stash_clear 清空所有储藏
    stash_clear(&repo).unwrap();
    let stashes_after_clear = list_stashes(&mut repo).unwrap();
    assert_eq!(stashes_after_clear.len(), 0);
}

#[test]
fn remote_branch_checkout_tracks_and_names_correctly() {
    let local_dir = tempdir("rem-local");
    let remote_dir = tempdir("rem-bare");

    // 1. 创建本地仓库并提交
    let local_repo = init_repo(&local_dir);
    std::fs::write(workdir(&local_repo).join("init.txt"), "remote test\n").unwrap();
    commit_all(&local_repo, "init");

    // 2. 创建裸仓库作为 remote
    Repository::init_bare(&remote_dir).unwrap();
    local_repo.remote("origin", remote_dir.to_str().unwrap()).unwrap();

    // 3. 推送分支到 origin: feat/cloud-x
    let workdir_path = workdir(&local_repo);
    crate::operations::run_git_cli(&workdir_path, &["push", "-u", "origin", "HEAD:feat/cloud-x"]).unwrap();

    // 4. fetch origin
    crate::operations::run_git_cli(&workdir_path, &["fetch", "origin"]).unwrap();

    // 5. 检出 origin/feat/cloud-x
    checkout_branch(&local_repo, "origin/feat/cloud-x").unwrap();

    // 6. 验证：当前 HEAD 必须是非 detached 的真实本地分支 "feat/cloud-x"！
    let status = git::read_status(&local_repo).unwrap();
    assert!(!status.detached, "HEAD must not be detached!");
    assert_eq!(status.branch.as_deref(), Some("feat/cloud-x"));
}

#[test]
fn remote_branch_delete_integration() {
    let local_dir = tempdir("del-rem-local");
    let remote_dir = tempdir("del-rem-bare");

    let local_repo = init_repo(&local_dir);
    std::fs::write(workdir(&local_repo).join("init.txt"), "remote del test\n").unwrap();
    commit_all(&local_repo, "init");

    // 创建裸仓库作为 remote
    Repository::init_bare(&remote_dir).unwrap();
    local_repo.remote("origin", remote_dir.to_str().unwrap()).unwrap();

    let workdir_path = workdir(&local_repo);

    // 创建并推送新分支
    create_branch(&local_repo, "feature/cloud-del", None).unwrap();
    crate::operations::run_git_cli(&workdir_path, &["push", "-u", "origin", "feature/cloud-del"]).unwrap();

    // 验证远端分支存在
    crate::operations::run_git_cli(&workdir_path, &["fetch", "origin"]).unwrap();
    let branches_before = list_branches(&local_repo).unwrap();
    assert!(branches_before.iter().any(|b| b.name == "feature/cloud-del"));
    assert!(branches_before.iter().any(|b| b.name == "origin/feature/cloud-del"));

    // 执行删除本地分支 + 远程分支
    delete_branch(&local_repo, "feature/cloud-del", false, true).unwrap();

    // 验证本地与远端分支均已被删除
    crate::operations::run_git_cli(&workdir_path, &["fetch", "--prune", "origin"]).unwrap();
    let branches_after = list_branches(&local_repo).unwrap();
    assert!(!branches_after.iter().any(|b| b.name == "feature/cloud-del"));
    assert!(!branches_after.iter().any(|b| b.name == "origin/feature/cloud-del"));
}

#[test]
fn run_git_cli_timeout_kills_stalled_command() {
    use std::time::Duration;

    let dir = tempdir("cli-timeout");
    let _repo = init_repo(&dir);

    #[cfg(windows)]
    let alias_arg = r#"alias.sleephang=!powershell -NoProfile -Command "Start-Sleep -Seconds 5""#;
    #[cfg(not(windows))]
    let alias_arg = r#"alias.sleephang=!sh -c "sleep 5""#;

    let err = crate::operations::run_git_cli_with_timeout(
        &dir,
        &["-c", alias_arg, "sleephang"],
        Duration::from_millis(200),
    )
    .unwrap_err();
    assert!(
        err.to_string().contains("超时"),
        "预期返回超时错误，实际为: {err}"
    );
}


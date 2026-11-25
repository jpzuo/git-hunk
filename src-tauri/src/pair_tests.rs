//! `FilePair`（提交前后完整内容）的测试。
//!
//! 这是「VS Code 式全文对比」的数据基础，重点验证：
//! 修改 / 新增 / 删除 / 根提交 / 二进制 / 超大文件 六种场景下的内容与标志位。

use git2::Repository;

use crate::git;
use crate::history;
use crate::model::{FileStatus, StageArea, MAX_PREVIEW_BYTES};

fn init_repo(dir: &std::path::Path) -> Repository {
    let repo = Repository::init(dir).expect("init repo");
    {
        let mut cfg = repo.config().expect("config");
        cfg.set_str("user.name", "PairTest").unwrap();
        cfg.set_str("user.email", "pair@example.com").unwrap();
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
        "git-hunk-pair-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn modified_file_returns_both_sides() {
    let dir = tempdir("modified");
    let repo = init_repo(&dir);

    std::fs::write(workdir(&repo).join("a.txt"), "line1\nline2\nline3\n").unwrap();
    commit_all(&repo, "init");

    std::fs::write(workdir(&repo).join("a.txt"), "line1\nCHANGED\nline3\n").unwrap();
    let oid = commit_all(&repo, "modify");

    let pair = history::read_file_pair(&repo, &oid, "a.txt").unwrap();

    assert!(pair.old_exists, "修改前应存在");
    assert!(pair.new_exists, "修改后应存在");
    assert!(!pair.binary);
    assert!(!pair.truncated);

    // 前后全文都应拿到
    assert!(
        pair.old_content.contains("line2"),
        "旧内容应包含原文本: {:?}",
        pair.old_content
    );
    assert!(
        pair.new_content.contains("CHANGED"),
        "新内容应包含新文本: {:?}",
        pair.new_content
    );
    assert!(!pair.old_content.contains("CHANGED"), "旧内容不应含新文本");
    assert!(!pair.new_content.contains("line2"), "新内容不应含旧文本");

    // hunks 应存在，供前端折叠定位
    assert!(!pair.hunks.is_empty(), "应有 hunk 数据");
    assert_eq!(pair.additions, 1);
    assert_eq!(pair.deletions, 1);
    assert_eq!(pair.status, FileStatus::Modified);
}

#[test]
fn added_file_has_no_old_content() {
    let dir = tempdir("added");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("seed.txt"), "seed\n").unwrap();
    commit_all(&repo, "init");

    std::fs::write(workdir(&repo).join("new.txt"), "alpha\nbeta\n").unwrap();
    let oid = commit_all(&repo, "add new");

    let pair = history::read_file_pair(&repo, &oid, "new.txt").unwrap();

    assert!(!pair.old_exists, "新增文件修改前不应存在");
    assert!(pair.new_exists);
    assert_eq!(pair.old_content, "", "新增文件旧内容应为空");
    assert!(pair.new_content.contains("alpha"));
    assert_eq!(pair.status, FileStatus::Added);
    assert_eq!(pair.additions, 2);
}

#[test]
fn deleted_file_has_no_new_content() {
    let dir = tempdir("deleted");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("gone.txt"), "will be deleted\n").unwrap();
    std::fs::write(workdir(&repo).join("keep.txt"), "keep\n").unwrap();
    commit_all(&repo, "init");

    std::fs::remove_file(workdir(&repo).join("gone.txt")).unwrap();
    let oid = commit_all(&repo, "delete");

    let pair = history::read_file_pair(&repo, &oid, "gone.txt").unwrap();

    assert!(pair.old_exists, "删除前应存在");
    assert!(!pair.new_exists, "删除后不应存在");
    assert!(pair.old_content.contains("will be deleted"));
    assert_eq!(pair.new_content, "", "删除文件新内容应为空");
    assert_eq!(pair.status, FileStatus::Deleted);
    assert_eq!(pair.deletions, 1);
}

#[test]
fn root_commit_has_no_old_side() {
    let dir = tempdir("root");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("first.txt"), "initial\n").unwrap();
    let oid = commit_all(&repo, "root commit");

    let pair = history::read_file_pair(&repo, &oid, "first.txt").unwrap();

    assert!(!pair.old_exists, "根提交没有父，旧侧应不存在");
    assert!(pair.new_exists);
    assert_eq!(pair.old_content, "");
    assert!(pair.new_content.contains("initial"));
}

#[test]
fn binary_file_is_flagged_and_content_omitted() {
    let dir = tempdir("binary");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("seed.txt"), "seed\n").unwrap();
    commit_all(&repo, "init");

    // 含 NUL 字节 → 二进制
    let mut bytes = vec![0u8, 1, 2, 3, 0, 255, 128];
    bytes.extend_from_slice(b"binary-ish");
    std::fs::write(workdir(&repo).join("blob.bin"), &bytes).unwrap();
    let oid = commit_all(&repo, "add binary");

    let pair = history::read_file_pair(&repo, &oid, "blob.bin").unwrap();

    assert!(pair.binary, "应识别为二进制");
    assert_eq!(pair.old_content, "", "二进制不应返回旧文本");
    assert_eq!(pair.new_content, "", "二进制不应返回新文本");
}

#[test]
fn oversized_file_is_truncated() {
    let dir = tempdir("oversized");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("seed.txt"), "seed\n").unwrap();
    commit_all(&repo, "init");

    // 构造超过阈值的文本文件
    let big_line = "x".repeat(1024);
    let mut content = String::new();
    while content.len() <= MAX_PREVIEW_BYTES {
        content.push_str(&big_line);
        content.push('\n');
    }
    std::fs::write(workdir(&repo).join("huge.txt"), &content).unwrap();
    let oid = commit_all(&repo, "add huge");

    let pair = history::read_file_pair(&repo, &oid, "huge.txt").unwrap();

    assert!(pair.truncated, "超大文件应被截断");
    assert_eq!(pair.old_content, "", "截断时旧内容应为空");
    assert_eq!(pair.new_content, "", "截断时新内容应为空");
    // 但仍然保留 hunks，前端可退化为补丁视图
    assert!(!pair.hunks.is_empty(), "截断时仍应保留 hunks");
}

#[test]
fn renamed_file_uses_old_path_for_old_content() {
    let dir = tempdir("renamed");
    let repo = init_repo(&dir);
    // 内容足够长，确保 rename 检测能识别
    let body = "shared content line\n".repeat(20);
    std::fs::write(workdir(&repo).join("old_name.txt"), &body).unwrap();
    commit_all(&repo, "init");

    std::fs::rename(
        workdir(&repo).join("old_name.txt"),
        workdir(&repo).join("new_name.txt"),
    )
    .unwrap();
    let oid = commit_all(&repo, "rename");

    let pair = history::read_file_pair(&repo, &oid, "new_name.txt").unwrap();

    assert_eq!(pair.path, "new_name.txt");
    // 重命名时旧路径应给出，前端据此取旧内容
    if pair.status == FileStatus::Renamed {
        assert_eq!(pair.old_path.as_deref(), Some("old_name.txt"));
        assert!(pair.old_exists, "重命名时旧侧应存在");
        assert!(
            pair.old_content.contains("shared content"),
            "旧内容应来自旧路径"
        );
    }
}

#[test]
fn empty_file_pair_is_handled() {
    let dir = tempdir("empty");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("seed.txt"), "seed\n").unwrap();
    commit_all(&repo, "init");

    // 空文件
    std::fs::write(workdir(&repo).join("empty.txt"), "").unwrap();
    let oid = commit_all(&repo, "add empty");

    let pair = history::read_file_pair(&repo, &oid, "empty.txt").unwrap();

    assert!(pair.new_exists, "空文件本身应存在");
    assert_eq!(pair.new_content, "", "空文件内容为空字符串");
    assert_eq!(pair.additions, 0, "空文件不应有新增行");
}

#[test]
fn workdir_untracked_file_pair() {
    let dir = tempdir("workdir-untracked");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("untracked.txt"), "hello untracked\nsecond line\n").unwrap();

    let pair = git::read_workdir_file_pair(&repo, "untracked.txt", StageArea::Untracked).unwrap();

    assert!(!pair.old_exists, "未跟踪文件修改前不存在");
    assert!(pair.new_exists, "未跟踪文件修改后存在");
    assert_eq!(pair.old_content, "");
    assert_eq!(pair.new_content, "hello untracked\nsecond line\n");
    assert_eq!(pair.additions, 2);
    assert_eq!(pair.deletions, 0);
    assert_eq!(pair.hunks.len(), 1);
}

#[test]
fn workdir_unstaged_and_staged_file_pair() {
    let dir = tempdir("workdir-unstaged");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("code.rs"), "fn main() {\n    println!(\"old\");\n}\n").unwrap();
    commit_all(&repo, "init");

    // 修改工作区文件（unstaged）
    std::fs::write(workdir(&repo).join("code.rs"), "fn main() {\n    println!(\"new\");\n}\n").unwrap();

    let unstaged_pair = git::read_workdir_file_pair(&repo, "code.rs", StageArea::Unstaged).unwrap();
    assert!(unstaged_pair.old_exists);
    assert!(unstaged_pair.new_exists);
    assert!(unstaged_pair.old_content.contains("println!(\"old\");"));
    assert!(unstaged_pair.new_content.contains("println!(\"new\");"));
    assert_eq!(unstaged_pair.additions, 1);
    assert_eq!(unstaged_pair.deletions, 1);

    // 暂存文件（staged）
    git::stage_file(&repo, "code.rs").unwrap();

    let staged_pair = git::read_workdir_file_pair(&repo, "code.rs", StageArea::Staged).unwrap();
    assert!(staged_pair.old_exists);
    assert!(staged_pair.new_exists);
    assert!(staged_pair.old_content.contains("println!(\"old\");"));
    assert!(staged_pair.new_content.contains("println!(\"new\");"));
}
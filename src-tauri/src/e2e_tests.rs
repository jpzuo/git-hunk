//! 端到端集成测试：用真实 git 仓库验证 M0 的完整闭环。
//!
//! 与 `tests.rs` 的单元测试互补 —— 这里模拟前端会发起的一整串操作：
//! 打开仓库 → 读状态 → 读 diff → hunk 级暂存 → 提交 → 验证历史。

use git2::Repository;

use crate::git;
use crate::model::{FileStatus, StageArea};

fn init_repo(dir: &std::path::Path) -> Repository {
    let repo = Repository::init(dir).expect("init repo");
    {
        let mut cfg = repo.config().expect("config");
        cfg.set_str("user.name", "E2E").unwrap();
        cfg.set_str("user.email", "e2e@example.com").unwrap();
    }
    repo
}

fn workdir(repo: &Repository) -> std::path::PathBuf {
    repo.workdir().unwrap().to_path_buf()
}

fn commit_all(repo: &Repository, msg: &str) {
    git::stage_all(repo).unwrap();
    git::commit(repo, msg).unwrap();
}

fn tempdir(tag: &str) -> std::path::PathBuf {
    let base = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!("git-hunk-e2e-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn full_flow_open_diff_stage_commit() {
    let dir = tempdir("flow");
    let repo = init_repo(&dir);

    // 1. 初始提交
    std::fs::write(workdir(&repo).join("app.rs"), "fn main() {\n    println!(\"v1\");\n}\n")
        .unwrap();
    commit_all(&repo, "init");

    let status = git::read_status(&repo).unwrap();
    assert!(status.staged.is_empty());
    assert!(status.unstaged.is_empty());
    assert_eq!(status.branch.as_deref(), Some("master").or(Some("main")));

    // 2. 修改文件 → 出现在未暂存分组
    std::fs::write(
        workdir(&repo).join("app.rs"),
        "fn main() {\n    println!(\"v2\");\n}\n",
    )
    .unwrap();

    let status = git::read_status(&repo).unwrap();
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "app.rs");
    assert_eq!(status.unstaged[0].status, FileStatus::Modified);

    // 3. 读取 diff
    let diff = git::read_file_diff(&repo, "app.rs", StageArea::Unstaged).unwrap();
    assert_eq!(diff.hunks.len(), 1);
    assert_eq!(diff.additions, 1);
    assert_eq!(diff.deletions, 1);

    // 4. hunk 级暂存
    git::stage_hunk(&repo, "app.rs", 0).unwrap();
    let status = git::read_status(&repo).unwrap();
    assert_eq!(status.staged.len(), 1, "hunk 应进入暂存区");
    assert!(status.unstaged.is_empty(), "工作区应与索引一致");

    // 5. 提交
    let res = git::commit(&repo, "feat: bump to v2").unwrap();
    assert_eq!(res.summary, "feat: bump to v2");

    // 6. 验证历史与干净状态
    let status = git::read_status(&repo).unwrap();
    assert!(status.staged.is_empty());
    assert!(status.unstaged.is_empty());
    assert!(status.untracked.is_empty());

    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.message().unwrap().trim(), "feat: bump to v2");
    assert_eq!(head.parent_count(), 1, "应有父提交");
}

#[test]
fn selective_staging_then_verify_index_content() {
    let dir = tempdir("selective");
    let repo = init_repo(&dir);

    let original: String = (1..=30).map(|i| format!("row{i}\n")).collect();
    std::fs::write(workdir(&repo).join("data.txt"), &original).unwrap();
    commit_all(&repo, "init");

    // 三处相距较远的修改 → 三个 hunk
    let modified = original
        .replace("row3\n", "row3-EDIT-A\n")
        .replace("row15\n", "row15-EDIT-B\n")
        .replace("row27\n", "row27-EDIT-C\n");
    std::fs::write(workdir(&repo).join("data.txt"), &modified).unwrap();

    let diff = git::read_file_diff(&repo, "data.txt", StageArea::Unstaged).unwrap();
    assert_eq!(diff.hunks.len(), 3, "应得到 3 个独立 hunk");

    // 只暂存第 0 和第 2 个 hunk（跳过中间那个）
    git::stage_hunk(&repo, "data.txt", 0).unwrap();
    git::stage_hunk(&repo, "data.txt", 1).unwrap(); // 暂存后索引变化，剩下 2 个 hunk，第 1 个是原第 2 个

    let status = git::read_status(&repo).unwrap();
    assert!(status.staged.iter().any(|f| f.path == "data.txt"));
    assert!(status.unstaged.iter().any(|f| f.path == "data.txt"));

    let staged_diff =
        git::read_file_diff(&repo, "data.txt", StageArea::Staged).unwrap();
    let unstaged_diff =
        git::read_file_diff(&repo, "data.txt", StageArea::Unstaged).unwrap();

    // 索引里应包含 A 与 C，工作区残留 B
    assert_eq!(
        staged_diff.hunks.len() + unstaged_diff.hunks.len(),
        3,
        "hunk 总数应守恒"
    );

    let index = repo.index().unwrap();
    let entry = index.get_path(std::path::Path::new("data.txt"), 0).unwrap();
    let blob = repo.find_blob(entry.id).unwrap();
    let indexed = String::from_utf8_lossy(blob.content()).to_string();

    assert!(indexed.contains("EDIT-A"), "暂存的 A 应在索引中");
    assert!(indexed.contains("EDIT-C"), "暂存的 C 应在索引中");
    assert!(!indexed.contains("EDIT-B"), "未暂存的 B 不应在索引中");

    let working = std::fs::read_to_string(workdir(&repo).join("data.txt")).unwrap();
    assert!(working.contains("EDIT-A") && working.contains("EDIT-B") && working.contains("EDIT-C"));
}

#[test]
fn untracked_file_lifecycle() {
    let dir = tempdir("untracked");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("base.txt"), "base\n").unwrap();
    commit_all(&repo, "init");

    // 新增未跟踪文件
    std::fs::write(workdir(&repo).join("brand-new.txt"), "line one\nline two\n").unwrap();

    let status = git::read_status(&repo).unwrap();
    assert_eq!(status.untracked.len(), 1);
    assert_eq!(status.untracked[0].path, "brand-new.txt");
    assert_eq!(status.untracked[0].status, FileStatus::Untracked);
    assert!(status.untracked[0].additions > 0, "未跟踪文件应统计新增行数");

    // 未跟踪文件也能拿到 hunk（合成）
    let diff = git::read_file_diff(&repo, "brand-new.txt", StageArea::Untracked).unwrap();
    assert_eq!(diff.hunks.len(), 1);
    assert!(diff.hunks[0].is_pure_addition());
    assert_eq!(diff.hunks[0].additions, 2);

    // 暂存后进入 staged 分组
    git::stage_file(&repo, "brand-new.txt").unwrap();
    let status = git::read_status(&repo).unwrap();
    assert!(status.staged.iter().any(|f| f.path == "brand-new.txt"));
    assert!(status.untracked.is_empty());

    // 提交后状态干净
    git::commit(&repo, "add brand new").unwrap();
    let status = git::read_status(&repo).unwrap();
    assert!(status.staged.is_empty());
    assert!(status.untracked.is_empty());
}

#[test]
fn unstage_hunk_moves_it_back_to_workdir() {
    let dir = tempdir("unstage");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("f.txt"), "a\nb\nc\n").unwrap();
    commit_all(&repo, "init");

    std::fs::write(workdir(&repo).join("f.txt"), "a\nB\nc\n").unwrap();
    git::stage_file(&repo, "f.txt").unwrap();

    let status = git::read_status(&repo).unwrap();
    assert_eq!(status.staged.len(), 1);

    // 取消暂存该 hunk
    git::unstage_hunk(&repo, "f.txt", 0).unwrap();

    let status = git::read_status(&repo).unwrap();
    assert!(status.staged.is_empty(), "取消暂存后应为空");
    assert_eq!(status.unstaged.len(), 1, "变更应回到工作区");
}

#[test]
fn amend_rewrites_head_keeping_parent() {
    let dir = tempdir("amend");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("x.txt"), "1\n").unwrap();
    commit_all(&repo, "first");
    std::fs::write(workdir(&repo).join("x.txt"), "2\n").unwrap();
    commit_all(&repo, "second");

    let before = repo.head().unwrap().peel_to_commit().unwrap();
    let before_parent = before.parent_id(0).unwrap();

    std::fs::write(workdir(&repo).join("y.txt"), "new\n").unwrap();
    git::stage_all(&repo).unwrap();
    let res = git::amend(&repo, "second (amended)").unwrap();

    let after = repo.find_commit(git2::Oid::from_str(&res.oid).unwrap()).unwrap();
    assert_eq!(after.message().unwrap().trim(), "second (amended)");
    assert_eq!(after.parent_count(), 1, "amend 后仍应只有一个父提交");
    assert_eq!(after.parent_id(0).unwrap(), before_parent, "父提交不变");
    assert!(res.oid != before.id().to_string(), "提交 id 应改变");
}

#[test]
fn discard_file_restores_tracked_content() {
    let dir = tempdir("discard");
    let repo = init_repo(&dir);
    std::fs::write(workdir(&repo).join("d.txt"), "original\n").unwrap();
    commit_all(&repo, "init");

    std::fs::write(workdir(&repo).join("d.txt"), "scrapped\n").unwrap();
    git::discard_file(&repo, "d.txt", StageArea::Unstaged).unwrap();

    let content = std::fs::read_to_string(workdir(&repo).join("d.txt")).unwrap();
    // Windows 上 core.autocrlf 可能把行尾转成 CRLF，比较时统一归一化
    assert_eq!(
        content.replace("\r\n", "\n"),
        "original\n",
        "工作区应还原为已提交内容"
    );
}

#[test]
fn rename_is_reported_with_old_path() {
    let dir = tempdir("rename");
    let repo = init_repo(&dir);
    let big = "content line\n".repeat(20);
    std::fs::write(workdir(&repo).join("old.txt"), &big).unwrap();
    commit_all(&repo, "init");

    std::fs::rename(workdir(&repo).join("old.txt"), workdir(&repo).join("new.txt")).unwrap();
    git::stage_all(&repo).unwrap();

    let status = git::read_status(&repo).unwrap();
    let renamed = status
        .staged
        .iter()
        .find(|f| f.status == FileStatus::Renamed)
        .expect("应识别为 rename");
    assert_eq!(renamed.path, "new.txt");
    assert_eq!(renamed.old_path.as_deref(), Some("old.txt"));
}

#[test]
fn test_batch_stage_unstage_discard_and_gitignore() {
    let dir = tempdir("batch");
    let repo = init_repo(&dir);

    // 1. 批量暂存多个文件与文件夹
    let sub = workdir(&repo).join("src").join("utils");
    std::fs::create_dir_all(&sub).unwrap();
    std::fs::write(sub.join("a.txt"), "hello a\n").unwrap();
    std::fs::write(sub.join("b.txt"), "hello b\n").unwrap();
    std::fs::write(workdir(&repo).join("root.txt"), "hello root\n").unwrap();

    git::stage_paths(
        &repo,
        &[
            "src/utils/a.txt".to_string(),
            "src/utils/b.txt".to_string(),
            "root.txt".to_string(),
        ],
    )
    .unwrap();

    let status = git::read_status(&repo).unwrap();
    assert_eq!(status.staged.len(), 3);

    // 2. 批量取消暂存
    git::unstage_paths(&repo, &["src/utils/a.txt".to_string(), "root.txt".to_string()]).unwrap();
    let status = git::read_status(&repo).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "src/utils/b.txt");

    // 3. 提交剩余暂存
    git::commit(&repo, "commit b").unwrap();

    // 4. 批量修改并测试批量放弃修改
    std::fs::write(sub.join("b.txt"), "modified b\n").unwrap();
    git::discard_paths(&repo, &["src/utils/b.txt".to_string()]).unwrap();
    let content = std::fs::read_to_string(sub.join("b.txt")).unwrap();
    assert_eq!(content.replace("\r\n", "\n"), "hello b\n");

    // 5. 测试添加到 .gitignore
    git::add_to_gitignore(&repo, "*.log").unwrap();
    git::add_to_gitignore(&repo, "dist/").unwrap();
    let gitignore = std::fs::read_to_string(workdir(&repo).join(".gitignore")).unwrap();
    assert!(gitignore.contains("*.log"));
    assert!(gitignore.contains("dist/"));

    // 6. 测试清理未跟踪文件
    let untracked_file = workdir(&repo).join("temp.tmp");
    std::fs::write(&untracked_file, "garbage").unwrap();
    assert!(untracked_file.exists());
    git::clean_untracked_paths(&repo, &["temp.tmp".to_string()]).unwrap();
    assert!(!untracked_file.exists());
}
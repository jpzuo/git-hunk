//! 提交历史与 DAG 泳道算法的测试。
//!
//! 重点测「纯算法」`assign_lanes`：它不依赖 git 仓库，可以精确构造拓扑序输入，
//! 把分叉、合并、多父提交等边界行为钉死。渲染层依赖它输出的 lane 与 segments。

use std::collections::HashSet;

use crate::history::{assign_lanes, CommitNode};
use crate::model::LaneSegment;

fn node(oid: &str, parents: &[&str]) -> CommitNode {
    CommitNode {
        oid: oid.to_string(),
        parents: parents.iter().map(|s| s.to_string()).collect(),
    }
}

/// 是否存在「从某泳道竖直向下」的线段。
fn has_straight(segs: &[LaneSegment], lane: u32) -> bool {
    segs.iter().any(|s| s.from_lane == lane && s.to_lane == lane)
}

#[test]
fn linear_history_uses_single_lane() {
    let nodes = vec![
        node("d", &["c"]),
        node("c", &["b"]),
        node("b", &["a"]),
        node("a", &[]),
    ];
    let lanes = assign_lanes(&nodes);

    assert_eq!(lanes.len(), 4);
    for l in &lanes {
        assert_eq!(l.lane, 0, "线性历史应始终在第 0 泳道");
    }
    for l in &lanes[0..3] {
        assert!(has_straight(&l.segments, 0), "主线应有竖直连线");
    }
    // 根提交没有父，因此没有向下的连线
    assert!(
        lanes[3].segments.is_empty(),
        "根提交不应有向下的连线: {:?}",
        lanes[3].segments
    );
}

#[test]
fn branch_fork_creates_two_lanes() {
    // c1、c2 是两个分支头，都指向同一个父 a
    let nodes = vec![
        node("c1", &["a"]),
        node("c2", &["a"]),
        node("a", &["root"]),
        node("root", &[]),
    ];
    let lanes = assign_lanes(&nodes);

    // 两个分支头必须在不同泳道
    assert_ne!(lanes[0].lane, lanes[1].lane, "两个分支头应占不同泳道");

    // 汇合到同一父提交 a：a 落在最早那条泳道（c1 的泳道）
    assert_eq!(
        lanes[2].lane, lanes[0].lane,
        "父提交应落在最早等待它的泳道"
    );

    // a 行必须有一条从 c2 泳道汇入 a 泳道的连线
    let c2_lane = lanes[1].lane;
    let a_lane = lanes[2].lane;
    assert!(
        lanes[2]
            .segments
            .iter()
            .any(|s| s.from_lane == c2_lane && s.to_lane == a_lane),
        "a 行应有 c2 泳道汇入的连线, segments={:?}",
        lanes[2].segments
    );
}

#[test]
fn merge_commit_forks_extra_lane() {
    // m 有两个父：p1（主线）、p2（被合并分支）
    let nodes = vec![
        node("m", &["p1", "p2"]),
        node("p1", &["base"]),
        node("p2", &["base"]),
        node("base", &["root"]),
        node("root", &[]),
    ];
    let lanes = assign_lanes(&nodes);

    let m_lane = lanes[0].lane;
    assert_eq!(lanes[0].merge_lanes.len(), 1, "合并提交应分叉出一条泳道");
    let forked = lanes[0].merge_lanes[0];
    assert_ne!(forked, m_lane, "分叉泳道不能与主线相同");

    // p1 继承主线泳道
    assert_eq!(lanes[1].lane, m_lane, "第一父提交继承主线");
    // p2 在被分叉的泳道
    assert_eq!(lanes[2].lane, forked, "第二父提交在被分叉的泳道");

    // 合并提交要有指向 p2 泳道的斜线
    assert!(
        lanes[0]
            .segments
            .iter()
            .any(|s| s.from_lane == m_lane && s.to_lane == forked),
        "合并提交应有指向分叉泳道的斜线"
    );
}

#[test]
fn root_commit_ends_its_lane() {
    let nodes = vec![node("root", &[])];
    let lanes = assign_lanes(&nodes);

    assert_eq!(lanes[0].lane, 0);
    assert!(
        lanes[0].segments.is_empty(),
        "根提交之后不应再有连线"
    );
}

#[test]
fn lanes_are_compacted_after_branch_ends() {
    let nodes = vec![
        node("f1", &["a"]),
        node("f2", &["a"]),
        node("a", &["root"]),
        node("root", &[]),
    ];
    let lanes = assign_lanes(&nodes);

    let max_lane = lanes.iter().map(|l| l.lane).max().unwrap();
    assert!(max_lane <= 1, "泳道应紧凑复用，实际最大泳道 = {max_lane}");
}

#[test]
fn three_parallel_heads_use_three_lanes() {
    let nodes = vec![
        node("h1", &["base"]),
        node("h2", &["base"]),
        node("h3", &["base"]),
        node("base", &["root"]),
        node("root", &[]),
    ];
    let lanes = assign_lanes(&nodes);

    let heads: HashSet<u32> = lanes[0..3].iter().map(|l| l.lane).collect();
    assert_eq!(heads.len(), 3, "三个分支头应在三条不同泳道");

    // base 汇合到最早泳道
    assert_eq!(lanes[3].lane, lanes[0].lane, "base 应在最早等待它的泳道");

    // 汇合行之后不应残留多余泳道
    assert!(
        lanes[4].segments.is_empty(),
        "根提交之后应无连线，实际: {:?}",
        lanes[4].segments
    );
}

#[test]
fn duplicate_parent_is_not_forked_twice() {
    // 两个子提交共享同一个父提交：shared 只应占一条泳道
    let nodes = vec![
        node("c1", &["shared"]),
        node("c2", &["shared"]),
        node("shared", &[]),
    ];
    let lanes = assign_lanes(&nodes);

    assert_eq!(
        lanes[2].lane, lanes[0].lane,
        "共享父提交应沿用最早泳道，不能被后来的子提交改写"
    );
    // shared 行只应有汇合连线（1->0），不应有竖直向下的残留连线
    assert_eq!(
        lanes[2].segments,
        vec![LaneSegment {
            from_lane: lanes[1].lane,
            to_lane: lanes[2].lane
        }],
        "共享父提交行只应有汇合线"
    );
}

#[test]
fn empty_input_returns_empty() {
    assert!(assign_lanes(&[]).is_empty());
}

#[test]
fn octopus_merge_creates_multiple_lanes() {
    // 章鱼合并：一个提交有三个父
    let nodes = vec![
        node("m", &["p1", "p2", "p3"]),
        node("p1", &["root"]),
        node("p2", &["root"]),
        node("p3", &["root"]),
        node("root", &[]),
    ];
    let lanes = assign_lanes(&nodes);

    assert_eq!(lanes[0].merge_lanes.len(), 2, "三个父提交应额外分叉两条泳道");
    // 三个父提交各占不同泳道
    let parent_lanes: HashSet<u32> = [lanes[1].lane, lanes[2].lane, lanes[3].lane]
        .into_iter()
        .collect();
    assert_eq!(parent_lanes.len(), 3, "三个父提交应在三条不同泳道");
    // 最终汇合到 root
    assert_eq!(lanes[4].lane, lanes[1].lane, "root 应落在最早泳道");
}

fn create_history_test_repo() -> (std::path::PathBuf, git2::Repository) {
    let base = std::env::temp_dir();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!("git-hunk-hist-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).unwrap();
    let repo = git2::Repository::init(&dir).unwrap();
    (dir, repo)
}

fn make_commit(
    repo: &git2::Repository,
    author_name: &str,
    author_email: &str,
    message: &str,
    time_offset: i64,
    parents: &[git2::Oid],
) -> git2::Oid {
    let workdir = repo.workdir().unwrap();
    let file_path = workdir.join("log.txt");
    std::fs::write(&file_path, format!("{message}\n")).unwrap();
    let mut idx = repo.index().unwrap();
    idx.add_path(std::path::Path::new("log.txt")).unwrap();
    idx.write().unwrap();
    let tree_oid = idx.write_tree().unwrap();
    let tree = repo.find_tree(tree_oid).unwrap();

    let time = git2::Time::new(1_700_000_000 + time_offset, 0);
    let sig = git2::Signature::new(author_name, author_email, &time).unwrap();
    let parent_commits: Vec<git2::Commit> =
        parents.iter().map(|id| repo.find_commit(*id).unwrap()).collect();
    let parent_refs: Vec<&git2::Commit> = parent_commits.iter().collect();

    repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)
        .unwrap()
}

#[test]
fn read_history_filters_beyond_first_page_with_pagination() {
    let (_dir, repo) = create_history_test_repo();

    // 构造 10 个按时间递增的提交；最早期几条包含特殊作者、正文、tag 和哈希
    let c0 = make_commit(&repo, "Alice", "alice@example.com", "init: legacy target commit\n\nbody ticket-999", 1, &[]);
    let c1 = make_commit(&repo, "Bob", "bob@example.com", "feat: match-item 1", 2, &[c0]);
    let c2 = make_commit(&repo, "Bob", "bob@example.com", "feat: match-item 2", 3, &[c1]);
    let mut prev = c2;
    for i in 3..9 {
        prev = make_commit(&repo, "Charlie", "charlie@example.com", &format!("chore: filler {i}"), i + 1, &[prev]);
    }
    let c9 = make_commit(&repo, "Bob", "bob@example.com", "feat: match-item 3", 12, &[prev]);

    // 在早期提交 c0 上挂标签
    let c0_obj = repo.find_object(c0, None).unwrap();
    let tag_sig = git2::Signature::now("Alice", "alice@example.com").unwrap();
    repo.tag("v1.0-special", &c0_obj, &tag_sig, "release tag", false)
        .unwrap();

    // 创建一个独立分支上的提交，验证 "__ALL__" 与分支范围联合筛选
    let branch_head = repo.find_commit(c2).unwrap();
    repo.branch("feature/extra", &branch_head, false).unwrap();
    repo.set_head("refs/heads/feature/extra").unwrap();
    let _side = make_commit(&repo, "SideDev", "side@example.com", "fix: side branch only", 20, &[c2]);
    // 切回主分支（默认 init 分支指向 c9）
    let main_ref = repo
        .branches(Some(git2::BranchType::Local))
        .unwrap()
        .flatten()
        .map(|(b, _)| b.name().unwrap().unwrap().to_string())
        .find(|n| n != "feature/extra")
        .unwrap();
    let main_commit = repo.find_commit(c9).unwrap();
    repo.branch(&main_ref, &main_commit, true).unwrap();
    repo.set_head(&format!("refs/heads/{main_ref}")).unwrap();

    // 1. 第一页 limit=2 时未命中任何 Bob，但搜索 "match-item"（共 3 条，其中两条在第 7/8 位）必须直接从第 1 页返回 2 条且 has_more=true
    let p1 = crate::history::read_history(&repo, 2, 0, Some("HEAD"), Some("MATCH-ITEM")).unwrap();
    assert_eq!(p1.commits.len(), 2);
    assert!(p1.has_more);
    assert_eq!(p1.lane_count, 1);
    assert!(p1.commits.iter().all(|c| c.segments.is_empty()));
    assert_eq!(p1.commits[0].summary, "feat: match-item 3");
    assert_eq!(p1.commits[1].summary, "feat: match-item 2");

    // 2. 滚动翻页获取剩余第 3 条命中
    let p2 = crate::history::read_history(&repo, 2, 2, Some("HEAD"), Some("match-item")).unwrap();
    assert_eq!(p2.commits.len(), 1);
    assert!(!p2.has_more);
    assert_eq!(p2.commits[0].summary, "feat: match-item 1");

    // 3. 验证可跨过首页（limit=2）命中第 10 条（最早期提交）：按正文、作者名、Tag 名、短 SHA（大写）搜索
    let c0_short_upper: String = c0.to_string().chars().take(7).collect::<String>().to_uppercase();
    for query in ["ticket-999", "alice", "v1.0-special", c0_short_upper.as_str()] {
        let hit = crate::history::read_history(&repo, 2, 0, Some("HEAD"), Some(query)).unwrap();
        assert_eq!(hit.commits.len(), 1, "query `{query}` 应命中早期提交 c0");
        assert_eq!(hit.commits[0].oid, c0.to_string());
    }

    // 4. 分支范围联动：HEAD 看不到 feature/extra 上的提交，切换到 "__ALL__" 后可检索到
    let head_side = crate::history::read_history(&repo, 10, 0, Some("HEAD"), Some("SideDev")).unwrap();
    assert!(head_side.commits.is_empty());
    let all_side = crate::history::read_history(&repo, 10, 0, Some("__ALL__"), Some("SideDev")).unwrap();
    assert_eq!(all_side.commits.len(), 1);
    assert_eq!(all_side.commits[0].summary, "fix: side branch only");
}

#[test]
fn history_cancellable_stops_revwalk() {
    let (_dir, repo) = create_history_test_repo();
    let mut prev = make_commit(&repo, "Dev", "dev@example.com", "init", 1, &[]);
    for i in 2..=150 {
        prev = make_commit(&repo, "Dev", "dev@example.com", &format!("commit {i}"), i, &[prev]);
    }

    let cancelled = crate::history::read_history_cancellable(
        &repo,
        50,
        0,
        Some("HEAD"),
        Some("commit"),
        || true,
    )
    .unwrap();
    assert!(cancelled.commits.is_empty());
    assert!(!cancelled.has_more);
}
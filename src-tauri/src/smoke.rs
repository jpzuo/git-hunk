//! 冒烟验证逻辑：供 `bin/smoke.rs` 调用，直接驱动真实业务函数。
//!
//! 与 `e2e_tests.rs` 的区别：这里不构造合成场景，而是在**用户指定的真实仓库**
//! 上验证同一套函数路径，用于人工验收与联调排查。

use std::path::Path;

use crate::error::AppResult;
use crate::git;
use crate::model::{ChangedFile, CommitResult};

pub struct SmokeReport {
    pub workdir: String,
    pub branch: Option<String>,
    pub staged: usize,
    pub unstaged: usize,
    pub untracked: usize,
    pub file_list: Vec<ChangedFile>,
    pub diff_path: String,
    pub hunk_count: usize,
    pub hunk_summaries: Vec<String>,
    pub stage_result: String,
    pub commit_result: String,
    pub after_staged: usize,
    pub after_unstaged: usize,
    pub after_untracked: usize,
}

/// 在给定仓库上跑完整闭环。任何一步失败都会提前返回错误。
pub fn run(path: &Path) -> AppResult<SmokeReport> {
    let path_str = path.to_string_lossy().replace('\\', "/");

    // 1. 打开仓库
    let repo = git::discover(&path_str)?;
    let status = git::read_status(&repo)?;

    let mut file_list: Vec<ChangedFile> = Vec::new();
    file_list.extend(status.staged.iter().cloned());
    file_list.extend(status.unstaged.iter().cloned());
    file_list.extend(status.untracked.iter().cloned());

    let (staged, unstaged, untracked) = (
        status.staged.len(),
        status.unstaged.len(),
        status.untracked.len(),
    );

    // 2. 选一个有 hunk 的文件做 diff 解析验证：优先未暂存，其次未跟踪
    let target = status
        .unstaged
        .iter()
        .find(|f| !f.binary)
        .or_else(|| status.untracked.iter().find(|f| !f.binary));

    let (diff_path, hunk_count, hunk_summaries) = match target {
        Some(file) => {
            let diff = git::read_file_diff(&repo, &file.path, file.area)?;
            let summaries = diff
                .hunks
                .iter()
                .map(|h| {
                    format!(
                        "hunk[{}] {}  +{} -{}  ({} 行)",
                        h.index,
                        h.header,
                        h.additions,
                        h.deletions,
                        h.lines.len()
                    )
                })
                .collect::<Vec<_>>();
            (file.path.clone(), diff.hunks.len(), summaries)
        }
        None => ("(无可用变更)".to_string(), 0, Vec::new()),
    };

    // 3. hunk 级暂存：把未暂存文件的第一个 hunk 暂存
    let stage_result = match status.unstaged.iter().find(|f| !f.binary) {
        Some(file) => {
            git::stage_hunk(&repo, &file.path, 0)?;
            let after = git::read_status(&repo)?;
            let ok = after.staged.iter().any(|f| f.path == file.path);
            format!(
                "暂存 {} 的第 0 个 hunk → {}",
                file.path,
                if ok { "成功（已进入暂存区）" } else { "失败（未进入暂存区）" }
            )
        }
        None => "跳过（没有可暂存的未暂存文件）".to_string(),
    };

    // 4. 提交：把当前索引内容提交掉，验证 commit 路径
    let commit_result = {
        let after_stage = git::read_status(&repo)?;
        if after_stage.staged.is_empty() {
            "跳过（暂存区为空）".to_string()
        } else {
            let msg = "smoke: verify hunk staging pipeline";
            let CommitResult { short_oid, summary, .. } = git::commit(&repo, msg)?;
            format!("提交成功 {short_oid} — {summary}")
        }
    };

    // 5. 提交后状态
    let final_status = git::read_status(&repo)?;

    Ok(SmokeReport {
        workdir: status.workdir,
        branch: status.branch,
        staged,
        unstaged,
        untracked,
        file_list,
        diff_path,
        hunk_count,
        hunk_summaries,
        stage_result,
        commit_result,
        after_staged: final_status.staged.len(),
        after_unstaged: final_status.unstaged.len(),
        after_untracked: final_status.untracked.len(),
    })
}
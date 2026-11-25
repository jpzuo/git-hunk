//! Git 扩展操作：分支管理、远程同步（Push/Pull/Fetch）、Stash 储藏、Tag 标签。
//!
//! 设计取向：
//! - 本地快速元数据读取、Tag 与分支创建/删除走 `git2` (libgit2)；
//! - 检出、Stash 应用、网络操作（Push/Pull/Fetch）统一走系统 `git` CLI，
//!   以无缝承载用户的系统凭据助手（GCM）、SSH 密钥与环境变量。

use std::io::Read as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use git2::{BranchType, ObjectType, Oid, Repository};

use crate::error::{AppError, AppResult};
use crate::model::{BranchInfo, RemoteInfo, StashInfo, SyncResult, TagInfo};

const LOCAL_GIT_CLI_TIMEOUT: Duration = Duration::from_secs(30);
const NETWORK_GIT_CLI_TIMEOUT: Duration = Duration::from_secs(120);

// ---------------------------------------------------------------------------
// 统一 CLI 调用辅助
// ---------------------------------------------------------------------------

/// 在工作目录执行本地 git CLI 命令（带 30 秒超时保护）。Windows 下禁用控制台弹窗。
pub fn run_git_cli<P: AsRef<Path>>(workdir: P, args: &[&str]) -> AppResult<SyncResult> {
    run_git_cli_with_timeout(workdir, args, LOCAL_GIT_CLI_TIMEOUT)
}

/// 在工作目录执行网络 git CLI 命令（带 120 秒超时保护）。
pub fn run_git_cli_network<P: AsRef<Path>>(workdir: P, args: &[&str]) -> AppResult<SyncResult> {
    run_git_cli_with_timeout(workdir, args, NETWORK_GIT_CLI_TIMEOUT)
}

/// 在工作目录执行 git CLI 命令并带超时终止保护（并发排空 stdout/stderr，防止管道写满死锁）。
pub fn run_git_cli_with_timeout<P: AsRef<Path>>(
    workdir: P,
    args: &[&str],
    timeout: Duration,
) -> AppResult<SyncResult> {
    let mut cmd = Command::new("git");
    cmd.current_dir(workdir.as_ref())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    for arg in args {
        cmd.arg(arg);
    }

    let mut child = cmd.spawn()?;
    let out_pipe = child.stdout.take();
    let err_pipe = child.stderr.take();

    let out_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = out_pipe {
            let _ = r.read_to_end(&mut buf);
        }
        buf
    });
    let err_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut r) = err_pipe {
            let _ = r.read_to_end(&mut buf);
        }
        buf
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait()? {
            Some(st) => break st,
            None => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = out_handle.join();
                    let _ = err_handle.join();
                    let subcmd = args.first().copied().unwrap_or("command");
                    return Err(AppError::State(format!(
                        "git {subcmd} 执行超时（超过 {} 秒），请检查网络连接或凭据配置",
                        timeout.as_secs()
                    )));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
        }
    };

    let stdout_bytes = out_handle.join().unwrap_or_default();
    let stderr_bytes = err_handle.join().unwrap_or_default();
    let stdout = String::from_utf8_lossy(&stdout_bytes).to_string();
    let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();

    if !status.success() {
        let err_msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            format!("git command failed with exit code: {:?}", status.code())
        };
        return Err(AppError::State(err_msg));
    }

    Ok(SyncResult {
        success: true,
        stdout,
        stderr,
    })
}

// ---------------------------------------------------------------------------
// 分支管理
// ---------------------------------------------------------------------------

/// 读取所有分支（本地 + 远程）
pub fn list_branches(repo: &Repository) -> AppResult<Vec<BranchInfo>> {
    let mut result = Vec::new();

    let branches = repo.branches(None)?;
    for entry in branches {
        let (branch, branch_type) = entry?;
        let is_remote = branch_type == BranchType::Remote;
        let name = branch
            .name()?
            .unwrap_or("")
            .to_string();

        let is_head = branch.is_head();

        let (target_oid, target_summary) = match branch.get().peel_to_commit() {
            Ok(c) => (c.id().to_string(), c.summary().unwrap_or("").to_string()),
            Err(_) => (String::new(), String::new()),
        };

        let mut upstream = None;
        let mut ahead = 0u32;
        let mut behind = 0u32;

        if !is_remote {
            if let Ok(up) = branch.upstream() {
                if let Ok(Some(u_name)) = up.name() {
                    upstream = Some(u_name.to_string());
                }
                if let (Some(local_target), Some(up_target)) =
                    (branch.get().target(), up.get().target())
                {
                    if let Ok((a, b)) = repo.graph_ahead_behind(local_target, up_target) {
                        ahead = a as u32;
                        behind = b as u32;
                    }
                }
            }
        }

        result.push(BranchInfo {
            name,
            is_head,
            is_remote,
            upstream,
            target_oid,
            target_summary,
            ahead,
            behind,
        });
    }

    // 排序：当前 HEAD 置顶，接着本地分支字母序，最后远程分支字母序
    result.sort_by(|a, b| {
        if a.is_head != b.is_head {
            return b.is_head.cmp(&a.is_head);
        }
        if a.is_remote != b.is_remote {
            return a.is_remote.cmp(&b.is_remote);
        }
        a.name.cmp(&b.name)
    });

    Ok(result)
}

/// 创建分支
pub fn create_branch(repo: &Repository, name: &str, target_oid: Option<&str>) -> AppResult<()> {
    let commit = if let Some(oid_str) = target_oid {
        let oid = Oid::from_str(oid_str.trim())?;
        repo.find_commit(oid)?
    } else {
        repo.head()?.peel_to_commit()?
    };

    repo.branch(name, &commit, false)?;
    Ok(())
}

/// 解析远程分支名，提取对应的 (remote_name, local_branch_name)
pub fn resolve_remote_branch(repo: &Repository, name: &str) -> Option<(String, String)> {
    let is_remote_branch = repo.find_branch(name, BranchType::Remote).is_ok();

    if let Ok(remotes) = repo.remotes() {
        for remote in remotes.iter().flatten() {
            let prefix = format!("{remote}/");
            if name.starts_with(&prefix) {
                let local_name = name[prefix.len()..].to_string();
                if !local_name.is_empty() {
                    return Some((remote.to_string(), local_name));
                }
            }
        }
    }

    if is_remote_branch {
        if let Some(pos) = name.find('/') {
            let remote = name[..pos].to_string();
            let local_name = name[pos + 1..].to_string();
            if !local_name.is_empty() {
                return Some((remote, local_name));
            }
        }
    }

    None
}

/// 切换分支 (checkout / switch)
pub fn checkout_branch(repo: &Repository, name: &str) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;

    // 若目标是远程分支（例如 "origin/feat/xxx"），自动检出或创建本地跟踪分支，
    // 确保切换后处于真实命名的本地分支，而不是 detached HEAD 状态
    if let Some((_remote, local_name)) = resolve_remote_branch(repo, name) {
        if repo.find_branch(&local_name, BranchType::Local).is_ok() {
            return run_git_cli(workdir, &["checkout", &local_name]);
        }
        return run_git_cli(workdir, &["checkout", "-b", &local_name, "--track", name]);
    }

    run_git_cli(workdir, &["checkout", name])
}

/// 解析本地分支对应的远程仓库与远程分支名，如 ("origin", "feature/login")
pub fn resolve_remote_branch_target(
    repo: &Repository,
    local_name: &str,
) -> AppResult<Option<(String, String)>> {
    // 1. 尝试从本地分支的 upstream 配置获取
    if let Ok(branch) = repo.find_branch(local_name, BranchType::Local) {
        if let Ok(upstream) = branch.upstream() {
            if let Ok(Some(up_name)) = upstream.name() {
                // upstream.name() 通常形如 "origin/feature/login"
                if let Some(slash_idx) = up_name.find('/') {
                    let remote = up_name[..slash_idx].to_string();
                    let remote_branch = up_name[slash_idx + 1..].to_string();
                    return Ok(Some((remote, remote_branch)));
                }
            }
        }
    }

    // 2. 若未配置 upstream，遍历所有配置的 remotes，检查是否存在同名的远程分支
    let remotes = repo.remotes()?;
    for remote in remotes.iter().flatten() {
        let remote_ref = format!("{}/{}", remote, local_name);
        if repo.find_branch(&remote_ref, BranchType::Remote).is_ok() {
            return Ok(Some((remote.to_string(), local_name.to_string())));
        }
    }

    // 3. 若只有一个远端（如 origin），默认解析为该远端
    if remotes.len() == 1 {
        if let Some(first_remote) = remotes.get(0) {
            return Ok(Some((first_remote.to_string(), local_name.to_string())));
        }
    }

    Ok(None)
}

/// 解析默认远程名称（若传参指定则用指定的；否则优先选择 origin；最后退化为第一个已配置远端）
pub fn resolve_default_remote(repo: &Repository, remote: Option<&str>) -> AppResult<String> {
    if let Some(r) = remote {
        let trimmed = r.trim();
        if !trimmed.is_empty() {
            return Ok(trimmed.to_string());
        }
    }
    let remotes = repo.remotes()?;
    for r in remotes.iter().flatten() {
        if r == "origin" {
            return Ok("origin".to_string());
        }
    }
    if let Some(first) = remotes.get(0) {
        return Ok(first.to_string());
    }
    Err(AppError::State("当前仓库尚未配置任何远程仓库 (git remote)".into()))
}

/// 删除分支（可选同时删除对应远程分支）
pub fn delete_branch(
    repo: &Repository,
    name: &str,
    force: bool,
    delete_remote: bool,
) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;

    let remote_target = if delete_remote {
        match resolve_remote_branch_target(repo, name)? {
            Some(target) => Some(target),
            None => {
                return Err(AppError::State(format!(
                    "未检测到本地分支 '{}' 对应的远程分支，取消删除操作。",
                    name
                )));
            }
        }
    } else {
        None
    };

    // 1. 删除本地分支
    let flag = if force { "-D" } else { "-d" };
    let local_res = run_git_cli(workdir, &["branch", flag, name])?;

    // 2. 若勾选删除远程分支
    if let Some((remote_name, remote_branch_name)) = remote_target {
        match run_git_cli_network(workdir, &["push", &remote_name, "--delete", &remote_branch_name]) {
            Ok(remote_res) => {
                let stdout = format!("{}\n{}", local_res.stdout, remote_res.stdout).trim().to_string();
                let stderr = format!("{}\n{}", local_res.stderr, remote_res.stderr).trim().to_string();
                Ok(SyncResult {
                    success: true,
                    stdout,
                    stderr,
                })
            }
            Err(err) => {
                // 远程删除失败时给出明确提示
                Err(AppError::State(format!(
                    "本地分支 '{}' 已删除，但删除远程分支 ({}/{}) 时失败: {}",
                    name, remote_name, remote_branch_name, err
                )))
            }
        }
    } else {
        Ok(local_res)
    }
}

/// 重命名分支
pub fn rename_branch(repo: &Repository, old_name: &str, new_name: &str) -> AppResult<()> {
    let mut branch = repo.find_branch(old_name, BranchType::Local)?;
    branch.rename(new_name, false)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 远程网络同步
// ---------------------------------------------------------------------------

/// 读取所有已配置的远程仓库
pub fn list_remotes(repo: &Repository) -> AppResult<Vec<RemoteInfo>> {
    let mut result = Vec::new();
    let remotes = repo.remotes()?;

    for name in remotes.iter().flatten() {
        if let Ok(r) = repo.find_remote(name) {
            result.push(RemoteInfo {
                name: name.to_string(),
                url: r.url().map(String::from),
                push_url: r.pushurl().map(String::from),
            });
        }
    }

    Ok(result)
}

/// Fetch 远程更新
pub fn fetch(repo: &Repository, remote: Option<&str>) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    if let Some(r) = remote {
        run_git_cli_network(workdir, &["fetch", r])
    } else {
        run_git_cli_network(workdir, &["fetch", "--all", "--prune"])
    }
}

/// Pull 远程更新并合并 (可选 rebase)
pub fn pull(
    repo: &Repository,
    remote: Option<&str>,
    branch: Option<&str>,
    rebase: bool,
) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let mut args = vec!["pull"];
    if rebase {
        args.push("--rebase");
    }
    if let (Some(r), Some(b)) = (remote, branch) {
        args.push(r);
        args.push(b);
    }
    run_git_cli_network(workdir, &args)
}

/// 撤销上一次提交 (保留暂存区与工作区，对应 VS Code 的 Git: Undo Last Commit / git reset --soft HEAD~1)
pub fn undo_commit(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["reset", "--soft", "HEAD~1"])
}

/// 放弃工作区所有更改 (恢复已跟踪修改，并清理未跟踪文件，对应 VS Code 的 Git: Discard All Changes)
/// 同步变更 (Fetch -> Pull --rebase -> Push)
pub fn sync(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    // 1. fetch
    let fetch_res = run_git_cli_network(workdir, &["fetch", "--all", "--prune"]).unwrap_or_else(|_| SyncResult {
        success: false,
        stdout: String::new(),
        stderr: String::new(),
    });
    // 2. pull --rebase
    let pull_res = run_git_cli_network(workdir, &["pull", "--rebase"]).unwrap_or_else(|_| SyncResult {
        success: false,
        stdout: String::new(),
        stderr: String::new(),
    });
    // 3. push
    let push_res = match run_git_cli_network(workdir, &["push"]) {
        Ok(res) => res,
        Err(err) => {
            if let Ok(head) = repo.head() {
                if let Some(branch_name) = head.shorthand() {
                    let remote = resolve_default_remote(repo, None).unwrap_or_else(|_| "origin".into());
                    run_git_cli_network(workdir, &["push", "-u", &remote, branch_name])?
                } else {
                    return Err(err);
                }
            } else {
                return Err(err);
            }
        }
    };
    let stdout = format!("{}\n{}\n{}", fetch_res.stdout, pull_res.stdout, push_res.stdout)
        .trim()
        .to_string();
    let stderr = format!("{}\n{}\n{}", fetch_res.stderr, pull_res.stderr, push_res.stderr)
        .trim()
        .to_string();
    Ok(SyncResult {
        success: true,
        stdout,
        stderr,
    })
}

/// 放弃所有未暂存的修改 (git checkout -- .)
pub fn discard_all_unstaged(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["checkout", "--", "."])
        .or_else(|_| run_git_cli(workdir, &["restore", "."]))
}

/// 取消所有已暂存的修改 (git restore --staged .)
pub fn unstage_all(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["restore", "--staged", "."])
        .or_else(|_| run_git_cli(workdir, &["reset", "HEAD", "--", "."]))
        .or_else(|_| run_git_cli(workdir, &["reset"]))
}

pub fn discard_all_changes(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let reset_res = run_git_cli(workdir, &["reset", "--hard", "HEAD"])
        .or_else(|_| run_git_cli(workdir, &["restore", "."]))
        .or_else(|_| run_git_cli(workdir, &["checkout", "--", "."]))?;
    let clean_res = run_git_cli(workdir, &["clean", "-fd"])?;
    Ok(SyncResult {
        success: true,
        stdout: format!("{}\n{}", reset_res.stdout, clean_res.stdout).trim().to_string(),
        stderr: format!("{}\n{}", reset_res.stderr, clean_res.stderr).trim().to_string(),
    })
}

/// 清理所有未跟踪文件 (git clean -fd)
pub fn clean_untracked(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["clean", "-fd"])
}

/// 中止当前正在进行的合并 (git merge --abort)
pub fn abort_merge(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["merge", "--abort"])
}

/// 中止当前正在进行的变基 (git rebase --abort)
pub fn abort_rebase(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["rebase", "--abort"])
}

/// 中止当前正在进行的拣选 (git cherry-pick --abort)
pub fn abort_cherry_pick(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["cherry-pick", "--abort"])
}

/// Push 本地提交到远端
pub fn push(
    repo: &Repository,
    remote: Option<&str>,
    branch: Option<&str>,
    set_upstream: bool,
    force: bool,
) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let mut args = vec!["push"];
    if set_upstream {
        args.push("-u");
    }
    if force {
        args.push("--force-with-lease");
    }
    if let (Some(r), Some(b)) = (remote, branch) {
        args.push(r);
        args.push(b);
    }
    run_git_cli_network(workdir, &args)
}

// ---------------------------------------------------------------------------
// 工作区储藏 (Stash)
// ---------------------------------------------------------------------------

/// 读取仓库中的所有 Stash
pub fn list_stashes(repo: &mut Repository) -> AppResult<Vec<StashInfo>> {
    let mut raw_stashes = Vec::new();

    repo.stash_foreach(|index, name, oid| {
        raw_stashes.push((index, name.to_string(), *oid));
        true
    })?;

    let mut list = Vec::with_capacity(raw_stashes.len());
    for (index, name, oid) in raw_stashes {
        let (summary, timestamp) = if let Ok(c) = repo.find_commit(oid) {
            (
                c.summary().unwrap_or("").to_string(),
                c.time().seconds(),
            )
        } else {
            (name.clone(), 0)
        };

        list.push(StashInfo {
            index,
            name,
            message: summary,
            oid: oid.to_string(),
            timestamp,
        });
    }

    Ok(list)
}

/// 保存工作区变更到 Stash
pub fn stash_save(
    repo: &Repository,
    message: Option<&str>,
    include_untracked: bool,
    keep_index: bool,
) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    if keep_index {
        args.push("--keep-index");
    }
    if let Some(m) = message {
        if !m.trim().is_empty() {
            args.push("-m");
            args.push(m);
        }
    }
    run_git_cli(workdir, &args)
}

/// 弹出并删除指定的 Stash (Pop)
pub fn stash_pop(repo: &Repository, index: usize) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let spec = format!("stash@{{{index}}}");
    run_git_cli(workdir, &["stash", "pop", &spec])
}

/// 应用指定的 Stash 但保留记录 (Apply)
pub fn stash_apply(repo: &Repository, index: usize) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let spec = format!("stash@{{{index}}}");
    run_git_cli(workdir, &["stash", "apply", &spec])
}

/// 丢弃指定的 Stash (Drop)
pub fn stash_drop(repo: &Repository, index: usize) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let spec = format!("stash@{{{index}}}");
    run_git_cli(workdir, &["stash", "drop", &spec])
}

/// 清空所有 Stash 储藏记录 (Clear)
pub fn stash_clear(repo: &Repository) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["stash", "clear"])
}

/// 基于指定的 Stash 创建并切换到新分支 (Branch from Stash)
pub fn stash_branch(
    repo: &Repository,
    branch_name: &str,
    index: usize,
) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let spec = format!("stash@{{{index}}}");
    run_git_cli(workdir, &["stash", "branch", branch_name, &spec])
}

// ---------------------------------------------------------------------------
// 标签管理 (Tags)
// ---------------------------------------------------------------------------

/// 读取所有标签信息
pub fn list_tags(repo: &Repository) -> AppResult<Vec<TagInfo>> {
    let mut result = Vec::new();
    let tag_names = repo.tag_names(None)?;

    for name in tag_names.iter().flatten() {
        if let Ok(reference) = repo.resolve_reference_from_short_name(name) {
            let (target_oid, target_summary) = match reference.peel_to_commit() {
                Ok(c) => (c.id().to_string(), c.summary().unwrap_or("").to_string()),
                Err(_) => (String::new(), String::new()),
            };

            let (message, tagger, timestamp) = if let Some(tag_obj) = reference
                .peel(ObjectType::Tag)
                .ok()
                .and_then(|o| o.into_tag().ok())
            {
                (
                    tag_obj.message().map(|m| m.trim().to_string()),
                    tag_obj.tagger().map(|t| t.name().unwrap_or("").to_string()),
                    tag_obj.tagger().map(|t| t.when().seconds()),
                )
            } else {
                (None, None, None)
            };

            result.push(TagInfo {
                name: name.to_string(),
                target_oid,
                target_summary,
                message,
                tagger,
                timestamp,
            });
        }
    }

    result.sort_by(|a, b| b.timestamp.unwrap_or(0).cmp(&a.timestamp.unwrap_or(0)));
    Ok(result)
}

/// 创建标签（轻量标签或附注标签，支持 force 覆盖及 push_remote 自动推送到远端）
pub fn create_tag(
    repo: &Repository,
    name: &str,
    target_oid: Option<&str>,
    message: Option<&str>,
    force: bool,
    push_remote: bool,
) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let obj = if let Some(oid_str) = target_oid {
        let oid = Oid::from_str(oid_str.trim())?;
        repo.find_object(oid, None)?
    } else {
        repo.head()?.peel(ObjectType::Commit)?
    };

    if let Some(msg) = message {
        if !msg.trim().is_empty() {
            let sig = repo.signature()?;
            repo.tag(name, &obj, &sig, msg.trim(), force)?;
        } else {
            repo.tag_lightweight(name, &obj, force)?;
        }
    } else {
        repo.tag_lightweight(name, &obj, force)?;
    }

    if push_remote {
        let remote_name = resolve_default_remote(repo, None)?;
        let mut args = vec!["push", &remote_name];
        if force {
            args.push("-f");
        }
        args.push(name);
        run_git_cli_network(workdir, &args)
    } else {
        Ok(SyncResult {
            success: true,
            stdout: format!("Created tag '{}'", name),
            stderr: String::new(),
        })
    }
}

/// 删除标签（可选同时删除远程标签）
pub fn delete_tag(
    repo: &Repository,
    name: &str,
    delete_remote: bool,
    remote: Option<&str>,
) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    // 1. 删除本地标签
    repo.tag_delete(name)?;

    // 2. 若勾选删除远程标签
    if delete_remote {
        let remote_name = resolve_default_remote(repo, remote)?;
        match run_git_cli_network(workdir, &["push", &remote_name, "--delete", name]) {
            Ok(res) => Ok(res),
            Err(err) => Err(AppError::State(format!(
                "本地标签 '{}' 已成功删除，但删除远程标签时失败: {}",
                name, err
            ))),
        }
    } else {
        Ok(SyncResult {
            success: true,
            stdout: format!("Deleted local tag '{}'", name),
            stderr: String::new(),
        })
    }
}

/// 推送指定标签到远端
pub fn push_tag(repo: &Repository, name: &str, remote: Option<&str>) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let remote_name = resolve_default_remote(repo, remote)?;
    run_git_cli_network(workdir, &["push", &remote_name, name])
}

/// 推送所有本地标签到远端 (git push <remote> --tags)
pub fn push_all_tags(repo: &Repository, remote: Option<&str>) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    let remote_name = resolve_default_remote(repo, remote)?;
    run_git_cli_network(workdir, &["push", &remote_name, "--tags"])
}

/// 检出标签 (进入分离头指针状态)
pub fn checkout_tag(repo: &Repository, name: &str) -> AppResult<SyncResult> {
    let workdir = repo.workdir().ok_or(AppError::NoRepo)?;
    run_git_cli(workdir, &["checkout", name])
}

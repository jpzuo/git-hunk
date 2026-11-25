//! 仓库变更监听：轮询状态指纹，变化时通过 Tauri 事件通知前端。
//!
//! 为什么用轮询而不是 inotify/ReadDirectoryChangesW：
//! - M0 阶段不引入额外依赖，保证可编译、可移植；
//! - 指纹比对（状态位 + 路径 + index 修改时间）成本极低，
//!   1.5s 间隔对本地仓库完全可以接受；
//! - 真正的文件系统 watch 留到 MVP 阶段用 `notify` 替换本模块内部实现，
//!   对外仍然只发 `repo://changed` 事件，前端无需改动。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use git2::{Repository, StatusOptions};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// 状态变更事件名，前端据此刷新。
pub const EVENT_REPO_CHANGED: &str = "repo://changed";

const POLL_INTERVAL: Duration = Duration::from_millis(1500);
const POLL_INTERVAL_HIDDEN: Duration = Duration::from_millis(10_000);

/// 启动后台监听线程。重复调用是安全的（由 `running` 标志保证只起一个）。
pub fn start(app: AppHandle, running: Arc<AtomicBool>) {
    if running.swap(true, Ordering::SeqCst) {
        return;
    }

    std::thread::spawn(move || {
        let mut last_fps: std::collections::HashMap<String, u64> =
            std::collections::HashMap::new();

        loop {
            if let Some(state) = app.try_state::<AppState>() {
                state
                    .visibility
                    .wait_interval(POLL_INTERVAL, POLL_INTERVAL_HIDDEN);
            } else {
                std::thread::sleep(POLL_INTERVAL);
                continue;
            }

            let Some(state) = app.try_state::<AppState>() else {
                continue;
            };

            let open_paths = state.get_open_paths();
            if open_paths.is_empty() {
                last_fps.clear();
                continue;
            }

            // 清理已关闭的工作区指纹
            last_fps.retain(|p, _| open_paths.contains(p));

            for path in open_paths {
                let fp_opt = git2::Repository::open(&path)
                    .ok()
                    .map(|repo| fingerprint(&repo));
                if let Some(fp) = fp_opt {
                    if let Some(&prev_fp) = last_fps.get(&path) {
                        if prev_fp != fp {
                            let _ = app.emit(EVENT_REPO_CHANGED, &path);
                            last_fps.insert(path, fp);
                        }
                    } else {
                        // 首次采样，记下指纹
                        last_fps.insert(path, fp);
                    }
                }
            }
        }
    });
}

/// 状态指纹：任何会影响 Source Control 面板的变化都会改变它。
fn fingerprint(repo: &Repository) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();

    // index 文件修改时间：stage / unstage 必然改变它
    if let Some(idx) = repo.path().join("index").metadata().ok() {
        if let Ok(modified) = idx.modified() {
            if let Ok(d) = modified.duration_since(SystemTime::UNIX_EPOCH) {
                d.as_nanos().hash(&mut hasher);
            }
        }
    }

    // HEAD 指向：commit / amend / checkout 会改变它
    if let Ok(head) = repo.head() {
        head.name().unwrap_or("").hash(&mut hasher);
        head.target().map(|o| o.to_string()).hash(&mut hasher);
    }

    // 工作区状态位与路径：新增/修改/删除文件会改变它
    let mut opts = StatusOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true);

    if let Ok(statuses) = repo.statuses(Some(&mut opts)) {
        for entry in statuses.iter() {
            entry.status().bits().hash(&mut hasher);
            entry.path().unwrap_or("").hash(&mut hasher);
        }
    }

    hasher.finish()
}
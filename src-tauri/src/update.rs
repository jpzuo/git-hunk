//! 应用自动更新（Tauri v2 `tauri-plugin-updater` 封装）。
//!
//! 设计要点：
//! - 更新流程完全在 Rust 侧完成，前端只调用本模块的两个命令，因此**无需**
//!   `@tauri-apps/plugin-updater` 依赖，也无需额外的 capability 授权。
//! - 检查到更新后把 `Update` 句柄暂存在 `PendingUpdate` 中，安装时再取出，
//!   避免前端多次重复请求更新源。
//! - 安装会触发进程退出：先置位 `AppState::allow_exit` 放行托管到托盘的退出拦截，
//!   否则 Windows 安装器会被常驻逻辑卡住。

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 更新元数据（序列化给前端展示）。
#[derive(Debug, Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

/// 下载进度事件（通过 `ipc::Channel` 推送给前端）。
/// `tag = "event"` 让前端能以判别式联合处理 `Started` / `Progress` / `Finished`。
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub enum UpdateProgress {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
    Finished,
}

/// 暂存的待安装更新句柄（`update_check` 写入，`update_install` 取出）。
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

fn updater_err(e: tauri_plugin_updater::Error) -> AppError {
    AppError::Updater(e.to_string())
}

/// 检查是否有可用更新。无更新时返回 `None`。
#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> AppResult<Option<UpdateInfo>> {
    let update = app
        .updater()
        .map_err(updater_err)?
        .check()
        .await
        .map_err(updater_err)?;

    let info = update.as_ref().map(|u| UpdateInfo {
        current_version: u.current_version.clone(),
        version: u.version.clone(),
        date: u.date.map(|d| d.to_string()),
        body: u.body.clone(),
    });

    *pending
        .0
        .lock()
        .map_err(|_| AppError::State("pending update lock poisoned".into()))? = update;

    Ok(info)
}

/// 下载并安装已检查到的更新。通过 `on_event` 汇报进度。
///
/// Windows：安装器会自动退出并重启应用，本命令可能不会返回；
/// 其他平台：安装完成后主动 `restart()`。
#[tauri::command]
pub async fn update_install(
    app: AppHandle,
    on_event: Channel<UpdateProgress>,
    pending: State<'_, PendingUpdate>,
    state: State<'_, AppState>,
) -> AppResult<()> {
    // 取出待安装更新，锁在 await 前释放（MutexGuard 不是 Send）。
    let update = {
        let mut guard = pending
            .0
            .lock()
            .map_err(|_| AppError::State("pending update lock poisoned".into()))?;
        guard
            .take()
            .ok_or_else(|| AppError::Updater("暂无可安装的更新，请先检查更新".into()))?
    };

    // 放行退出拦截，避免更新安装时被「关闭即隐藏到托盘」逻辑卡住。
    state.allow_exit();

    let mut started = false;
    update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    let _ = on_event.send(UpdateProgress::Started { content_length });
                    started = true;
                }
                let _ = on_event.send(UpdateProgress::Progress { chunk_length });
            },
            || {
                let _ = on_event.send(UpdateProgress::Finished);
            },
        )
        .await
        .map_err(updater_err)?;

    // macOS / Linux 需主动重启以运行新版本；Windows 由安装器接管（通常不会执行到这里）。
    #[cfg(not(windows))]
    app.restart();
    // Windows 上 app 仅在此处未被使用，显式引用以避免 unused 告警。
    #[cfg(windows)]
    let _ = &app;

    Ok(())
}

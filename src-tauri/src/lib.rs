//! git-hunk 后端入口。
//!
//! M0 阶段目标：接好 git2，提供仓库打开、状态读取、diff 解析、hunk 级 stage/discard、
//! commit 等最小闭环能力，并通过 Tauri 命令暴露给前端。

// MSVC 链接器会通过 stdout 报告「正在创建库 …lib」这类正常信息，
// 被 rustc 当作 linker_messages 告警；这里关掉以免淹没真正的告警。
#![allow(linker_messages)]

mod catalog;
mod commands;
mod content_search;
mod error;
mod git;
mod history;
mod model;
mod operations;
mod project_scripts;
mod script_runner;
mod state;
mod watcher;

/// 冒烟验证入口，供 `bin/smoke.rs` 在真实仓库上驱动业务函数。
pub mod smoke;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod e2e_tests;

#[cfg(test)]
mod history_tests;

#[cfg(test)]
mod pair_tests;

#[cfg(test)]
mod operation_tests;

#[cfg(test)]
mod workspace_tests;

#[cfg(test)]
mod catalog_tests;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

use state::AppState;

/// 恢复并置顶显示主窗口。
fn restore_main_window(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.visibility.set_visible(true);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let is_quitting = Arc::new(AtomicBool::new(false));
    let quitting_for_tray = Arc::clone(&is_quitting);
    let quitting_for_window = Arc::clone(&is_quitting);
    let quitting_for_run = is_quitting;

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            restore_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .setup(move |app| {
            // 初始化仓库管理中心存储路径
            if let Some(state) = app.try_state::<AppState>() {
                state.init_catalog_path(&app.handle().clone());
            }

            // 创建系统托盘与右键菜单（支持点击恢复窗口与真正退出应用）
            let show_item = MenuItem::with_id(app, "tray_show", "显示主窗口", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "退出 git-hunk", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

            let mut tray_builder = TrayIconBuilder::with_id("main-tray")
                .menu(&tray_menu)
                .tooltip("git-hunk")
                .show_menu_on_left_click(false)
                .on_menu_event(move |app_handle, event| match event.id().as_ref() {
                    "tray_show" => restore_main_window(app_handle),
                    "tray_quit" => {
                        quitting_for_tray.store(true, Ordering::SeqCst);
                        if let Some(state) = app_handle.try_state::<AppState>() {
                            state.stop_all_scripts();
                        }
                        app_handle.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        restore_main_window(tray.app_handle());
                    }
                    _ => {}
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                tray_builder = tray_builder.icon(icon);
            }
            tray_builder.build(app)?;

            // 仓库变更监听：状态变化时向前端推送 repo://changed
            let watcher_flag = Arc::new(AtomicBool::new(false));
            watcher::start(app.handle().clone(), watcher_flag);
            Ok(())
        })
        .on_window_event(move |window, event| match event {
            // 拦截 Alt+F4 / 任务栏关闭等系统关闭请求，改为隐藏到系统托盘并降频后台监视
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if !quitting_for_window.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Some(state) = window.try_state::<AppState>() {
                        state.visibility.set_visible(false);
                    }
                    let _ = window.hide();
                }
            }
            tauri::WindowEvent::Focused(true) => {
                if let Some(state) = window.try_state::<AppState>() {
                    state.visibility.set_visible(true);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::repo_open,
            commands::repo_discover,
            commands::repo_status,
            // 多工作区
            commands::workspace_open,
            commands::workspace_switch,
            commands::workspace_close,
            commands::workspace_list,
            commands::repo_diff_file,
            commands::repo_workdir_file_pair,
            commands::repo_stage_file,
            commands::repo_unstage_file,
            commands::repo_discard_file,
            commands::repo_stage_paths,
            commands::repo_unstage_paths,
            commands::repo_discard_paths,
            commands::repo_clean_untracked_paths,
            commands::repo_add_to_gitignore,
            commands::repo_stage_hunk,
            commands::repo_unstage_hunk,
            commands::repo_discard_hunk,
            commands::repo_commit,
            commands::repo_amend,
            commands::repo_undo_commit,
            commands::repo_discard_all_changes,
            commands::repo_discard_all_unstaged,
            commands::repo_unstage_all,
            commands::repo_clean_untracked,
            commands::repo_sync,
            commands::repo_abort_merge,
            commands::repo_abort_rebase,
            commands::repo_abort_cherry_pick,
            commands::repo_history,
            commands::repo_cancel_history_search,
            commands::repo_commit_detail,
            commands::repo_commit_file_diff,
            commands::repo_commit_file_pair,
            // 分支
            commands::repo_branches,
            commands::repo_branch_create,
            commands::repo_branch_checkout,
            commands::repo_branch_delete,
            commands::repo_branch_rename,
            // 远程
            commands::repo_remotes,
            commands::repo_fetch,
            commands::repo_pull,
            commands::repo_push,
            // Stash
            commands::repo_stashes,
            commands::repo_stash_save,
            commands::repo_stash_pop,
            commands::repo_stash_apply,
            commands::repo_stash_drop,
            commands::repo_stash_clear,
            commands::repo_stash_branch,
            // Tag
            commands::repo_tags,
            commands::repo_tag_create,
            commands::repo_tag_delete,
            commands::repo_tag_push,
            commands::repo_tag_push_all,
            commands::repo_tag_checkout,
            // 仓库管理中心与分组
            commands::catalog_list,
            commands::catalog_repo_rename,
            commands::catalog_repo_set_group,
            commands::catalog_repo_remove,
            commands::catalog_group_create,
            commands::catalog_group_rename,
            commands::catalog_group_delete,
            commands::catalog_discover_worktrees,
            commands::catalog_import_worktrees,
            // 原生窗口控制
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            commands::window_is_maximized,
            commands::window_start_dragging,
            // 系统与外部工具联动
            commands::system_open_file,
            commands::system_reveal_in_explorer,
            commands::system_open_terminal,
            // 工作区文件目录浏览与只读预览
            commands::repo_read_dir,
            commands::repo_search_files,
            commands::repo_read_file,
            commands::repo_search_content,
            commands::repo_cancel_content_search,
            // 项目脚本解析与并发执行
            commands::repo_discover_scripts,
            commands::repo_run_script,
            commands::repo_stop_script,
            commands::repo_list_running_scripts,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app_handle, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() && !quitting_for_run.load(Ordering::SeqCst) {
                    api.prevent_exit();
                } else if let Some(state) = app_handle.try_state::<AppState>() {
                    state.stop_all_scripts();
                }
            }
            tauri::RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    state.stop_all_scripts();
                }
            }
            _ => {}
        });
}

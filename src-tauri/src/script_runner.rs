//! 跨平台项目脚本并发运行器：支持实时 ANSI 流式日志、进程树彻底回收与退出清理。

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RunScriptRequest {
    pub script_id: String,
    pub name: String,
    pub cwd: String,
    pub display_command: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScriptRunSession {
    pub run_id: String,
    pub workdir: String,
    pub script_id: String,
    pub name: String,
    pub cwd: String,
    pub display_command: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub started_at: i64,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScriptOutputEvent {
    pub run_id: String,
    pub stream: String,
    pub chunk: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ScriptExitEvent {
    pub run_id: String,
    pub exit_code: Option<i32>,
    pub success: bool,
    pub stopped_by_user: bool,
}

struct RunningProcess {
    pid: u32,
    session: ScriptRunSession,
    stopped_by_user: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct ScriptRunnerManager {
    next_seq: AtomicU64,
    processes: Arc<Mutex<HashMap<String, RunningProcess>>>,
}

pub fn resolve_script_cwd(workdir: &Path, raw_cwd: &str) -> AppResult<std::path::PathBuf> {
    let trimmed = raw_cwd.trim();
    let target = if trimmed.is_empty() || trimmed == "." {
        workdir.to_path_buf()
    } else {
        let rel = Path::new(trimmed);
        for c in rel.components() {
            if matches!(
                c,
                std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
            ) {
                return Err(AppError::InvalidPath(
                    "Script working directory must stay within workspace".into(),
                ));
            }
        }
        workdir.join(rel)
    };

    if !target.exists() || !target.is_dir() {
        return Err(AppError::InvalidPath(format!(
            "Script working directory does not exist: {}",
            target.to_string_lossy()
        )));
    }

    let canon_workdir = workdir.canonicalize()?;
    let canon_target = target.canonicalize()?;
    if !canon_target.starts_with(&canon_workdir) {
        return Err(AppError::InvalidPath(
            "Script working directory escapes workspace".into(),
        ));
    }

    Ok(canon_target)
}

fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let _ = Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let pgid = format!("-{pid}");
        let _ = Command::new("kill").args(["-TERM", &pgid]).output();
        std::thread::sleep(std::time::Duration::from_millis(120));
        let _ = Command::new("kill").args(["-KILL", &pgid]).output();
    }
}

/// 将读取到的字节安全转换为完整 UTF-8 字符串，保留尾部跨块截断的多字节残片等待下次拼接。
pub(crate) fn decode_utf8_streaming(pending: &mut Vec<u8>, incoming: &[u8]) -> String {
    pending.extend_from_slice(incoming);
    match std::str::from_utf8(pending) {
        Ok(s) => {
            let out = s.to_string();
            pending.clear();
            out
        }
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            let out = std::str::from_utf8(&pending[..valid_up_to])
                .unwrap_or("")
                .to_string();
            if e.error_len().is_some() {
                // 非法字节跳过并用 U+FFFD 兜底，防止永久堵塞
                let mut rest = pending.split_off(valid_up_to);
                let skip = e.error_len().unwrap_or(1).min(rest.len());
                rest.drain(..skip);
                *pending = rest;
                return format!("{out}\u{FFFD}");
            }
            *pending = pending.split_off(valid_up_to);
            out
        }
    }
}

fn spawn_output_reader<R: Read + Send + 'static>(
    app: AppHandle,
    run_id: String,
    stream_name: &'static str,
    mut reader: R,
) {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    const FLUSH_INTERVAL: Duration = Duration::from_millis(35);
    const FLUSH_MAX_BYTES: usize = 16 * 1024;

    let (tx, rx) = mpsc::sync_channel::<String>(64);

    // 读线程：专注阻塞读取管道并做流式 UTF-8 边界解码，遇到背压平滑等待
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = decode_utf8_streaming(&mut pending, &buf[..n]);
                    if !chunk.is_empty() && tx.send(chunk).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).to_string();
            if !tail.is_empty() {
                let _ = tx.send(tail);
            }
        }
    });

    // 批发送线程：按 35ms / 16KB 微批合并 IPC 推送，避免构建刷屏时触发前端渲染风暴
    std::thread::spawn(move || {
        let mut batch = String::new();
        let mut last_flush = Instant::now();

        let emit_batch = |buf: &mut String| {
            if buf.is_empty() {
                return;
            }
            let chunk = std::mem::take(buf);
            let _ = app.emit(
                "script://output",
                ScriptOutputEvent {
                    run_id: run_id.clone(),
                    stream: stream_name.to_string(),
                    chunk,
                },
            );
        };

        loop {
            let wait = FLUSH_INTERVAL.saturating_sub(last_flush.elapsed());
            match rx.recv_timeout(wait) {
                Ok(part) => {
                    batch.push_str(&part);
                    if batch.len() >= FLUSH_MAX_BYTES || last_flush.elapsed() >= FLUSH_INTERVAL {
                        emit_batch(&mut batch);
                        last_flush = Instant::now();
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if !batch.is_empty() {
                        emit_batch(&mut batch);
                    }
                    last_flush = Instant::now();
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    emit_batch(&mut batch);
                    break;
                }
            }
        }
    });
}

impl ScriptRunnerManager {
    pub fn list_running(&self) -> Vec<ScriptRunSession> {
        let Ok(guard) = self.processes.lock() else {
            return Vec::new();
        };
        let mut list: Vec<ScriptRunSession> =
            guard.values().map(|p| p.session.clone()).collect();
        list.sort_by_key(|s| s.started_at);
        list
    }

    pub fn start_script(
        &self,
        app: AppHandle,
        workdir: &Path,
        req: RunScriptRequest,
    ) -> AppResult<ScriptRunSession> {
        if req.display_command.trim().is_empty() {
            return Err(AppError::State("脚本命令为空".into()));
        }

        let target_cwd = resolve_script_cwd(workdir, &req.cwd)?;
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let run_id = format!("run-{seq}");
        let started_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let mut cmd = build_shell_command(&req.display_command, &target_cwd);
        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::State(format!("启动脚本失败: {e}")))?;

        let pid = child.id();
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let workdir_str = workdir.to_string_lossy().replace('\\', "/");
        let session = ScriptRunSession {
            run_id: run_id.clone(),
            workdir: workdir_str,
            script_id: req.script_id,
            name: req.name,
            cwd: req.cwd,
            display_command: req.display_command,
            status: "running".to_string(),
            exit_code: None,
            started_at,
        };

        let stopped_flag = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self
                .processes
                .lock()
                .map_err(|_| AppError::State("script runner lock poisoned".into()))?;
            guard.insert(
                run_id.clone(),
                RunningProcess {
                    pid,
                    session: session.clone(),
                    stopped_by_user: stopped_flag.clone(),
                },
            );
        }

        if let Some(out) = stdout {
            spawn_output_reader(app.clone(), run_id.clone(), "stdout", out);
        }
        if let Some(err) = stderr {
            spawn_output_reader(app.clone(), run_id.clone(), "stderr", err);
        }

        let map_arc = self.processes.clone();
        let wait_run_id = run_id.clone();
        std::thread::spawn(move || {
            let status = child.wait().ok();
            let exit_code = status.and_then(|s| s.code());
            let stopped_by_user = stopped_flag.load(Ordering::SeqCst);
            let success = !stopped_by_user && status.is_some_and(|s| s.success());

            if let Ok(mut guard) = map_arc.lock() {
                guard.remove(&wait_run_id);
            }

            let _ = app.emit(
                "script://exit",
                ScriptExitEvent {
                    run_id: wait_run_id,
                    exit_code,
                    success,
                    stopped_by_user,
                },
            );
        });

        Ok(session)
    }

    pub fn stop_script(&self, run_id: &str) -> AppResult<()> {
        let pid_opt = {
            let Ok(guard) = self.processes.lock() else {
                return Ok(());
            };
            if let Some(entry) = guard.get(run_id) {
                entry.stopped_by_user.store(true, Ordering::SeqCst);
                Some(entry.pid)
            } else {
                None
            }
        };

        if let Some(pid) = pid_opt {
            kill_process_tree(pid);
        }
        Ok(())
    }

    pub fn stop_for_workdir(&self, workdir_str: &str) {
        let norm = workdir_str.replace('\\', "/").to_lowercase();
        let pids: Vec<u32> = {
            let Ok(guard) = self.processes.lock() else {
                return;
            };
            guard
                .values()
                .filter(|p| p.session.workdir.to_lowercase() == norm)
                .map(|p| {
                    p.stopped_by_user.store(true, Ordering::SeqCst);
                    p.pid
                })
                .collect()
        };
        for pid in pids {
            kill_process_tree(pid);
        }
    }

    pub fn stop_all(&self) {
        let pids: Vec<u32> = {
            let Ok(guard) = self.processes.lock() else {
                return;
            };
            guard
                .values()
                .map(|p| {
                    p.stopped_by_user.store(true, Ordering::SeqCst);
                    p.pid
                })
                .collect()
        };
        for pid in pids {
            kill_process_tree(pid);
        }
    }
}

pub fn build_shell_command(command_line: &str, cwd: &Path) -> Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;

        let mut cmd = Command::new("cmd.exe");
        cmd.args(["/C", command_line])
            .current_dir(cwd)
            .env("FORCE_COLOR", "1")
            .env("CLICOLOR_FORCE", "1")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
        cmd
    }
    #[cfg(not(target_os = "windows"))]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", command_line])
            .current_dir(cwd)
            .env("FORCE_COLOR", "1")
            .env("CLICOLOR_FORCE", "1")
            .env("PYTHONUNBUFFERED", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        cmd
    }
}

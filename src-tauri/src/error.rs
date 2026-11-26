//! 统一错误类型，便于 command 层直接 `?` 并序列化给前端。

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("git error: {0}")]
    Git(#[from] git2::Error),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("invalid path: {0}")]
    InvalidPath(String),

    #[error("no repository is open")]
    NoRepo,

    #[error("hunk index {index} is out of range (total {total})")]
    HunkOutOfRange { index: usize, total: usize },

    #[error("state error: {0}")]
    State(String),

    #[error("update error: {0}")]
    Updater(String),

    #[error("tauri error: {0}")]
    Tauri(#[from] tauri::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
use std::{
    io,
    path::{Path, PathBuf},
};

#[derive(Debug, thiserror::Error)]
pub enum CompareError {
    #[error("Invalid image: {0}")]
    InvalidImage(String),
    #[error("PNG codec: {0}")]
    Codec(String),
    #[error("Invalid comparison argument: {0}")]
    InvalidArgument(String),
    #[error("Comparison resource limit: {0}")]
    ResourceLimit(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("I/O {operation} at {path:?}: {source}")]
    IoAt {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Artifact rename failed after {attempts} attempt(s) ({from:?} -> {to:?}): {source}")]
    ArtifactRename {
        from: PathBuf,
        to: PathBuf,
        attempts: u8,
        #[source]
        source: io::Error,
    },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl CompareError {
    pub fn io_at(operation: &'static str, path: &Path, source: io::Error) -> Self {
        Self::IoAt {
            operation,
            path: path.to_path_buf(),
            source,
        }
    }
}

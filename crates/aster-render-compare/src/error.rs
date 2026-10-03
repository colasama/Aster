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
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

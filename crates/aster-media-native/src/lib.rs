//! Authorized native media snapshots and bounded decode, independent of GPU execution.
mod still;
#[cfg(test)]
mod tests;
pub use still::{
    DecodedStill, NativeImageReceipt, NativeStillDecoder, StillAuthorization, StillLimits,
};

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("native media authorization failed: {0}")]
    Authorization(String),
    #[error("native media resource limit: {0}")]
    Limit(String),
    #[error("native media source identity differs")]
    Identity,
    #[error("unsupported native media: {0}")]
    Unsupported(String),
    #[error(transparent)]
    Resource(#[from] aster_render_ir::IrError),
    #[error(transparent)]
    Decode(#[from] aster_video::FfmpegError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

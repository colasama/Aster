//! Authorized native media snapshots and bounded decode, independent of GPU execution.
mod authorization;
pub use authorization::StillAuthorization;
mod exr_snapshot;
#[cfg(test)]
mod exr_tests;
#[cfg(windows)]
mod image_windows;
mod session;
#[cfg(test)]
mod session_tests;
mod still;
mod texture;
mod texture_codec;
#[cfg(test)]
mod texture_tests;
pub use session::{DecodedMedia, MediaCacheLimits, MediaCacheStatistics, NativeMediaSession};
pub use texture::{DecodedTexture, NativeTextureReceipt, NativeTextureSession, TextureLimits};
mod video;
mod video_prefetch;
mod video_time;
mod video_window;
pub use video::{
    DecodedVideo, NativeVideoDecoder, NativeVideoReceipt, VideoLimits, VideoSourceCacheStatistics,
};
pub use video_window::VideoWindowStatistics;
#[cfg(test)]
mod tests;
pub use still::{DecodedStill, NativeImageReceipt, NativeStillDecoder, StillLimits};

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("native EXR decode failed: {0}")]
    Exr(String),
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

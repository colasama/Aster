//! Decode-backend-independent video metadata, selection, and bounded caches.
//!
//! Its bounded FFmpeg backend provides process-isolated video-frame and
//! audio-range decode. Video output is repacked into GPU-copy-aligned layouts, while
//! canonical audio remains an explicitly bounded preview/playback path.

mod audio;
mod audio_format;
pub use audio_format::{AudioProbe, AudioSampleFormat};
mod export;
mod exr;
mod ffmpeg;
mod process;
mod still;
mod video_snapshot;
mod video_snapshot_input;
pub use video_snapshot_input::VideoSnapshotInput;
mod webp_header;
pub use video_snapshot::{PresentationFrame, VideoSnapshot};
#[cfg(test)]
mod still_tests;
pub use still::StillEncoding;

pub use audio::{AudioDecodeRequest, AudioLimits, DecodedAudio};

pub use exr::{
    ExrBackend, ExrError, ExrFrame, ExrLimits, ExrPrecision, ExrSequenceRequest, ExrWriteReport,
    ExrWriteRequest,
};

pub use export::{
    AudioEncoder, AudioMuxSpec, EncodedVideoExportReport, EncodedVideoExportRequest,
    EncoderAvailability, ExportContainer, ExportError, ExportFrame, ExportFrameReceiver,
    ExportFrameSendError, ExportFrameSender, ExportLimits, ExportReport, FfmpegExportBackend,
    PixelFormat, VideoCodec, VideoEncoder, VideoExportRequest,
};

pub use ffmpeg::{
    CancellationToken, DecodeLimits, FfmpegBackend, FfmpegCommand, FfmpegError, FfprobeBackend,
    FfprobeCommand, FfprobeError, ProbeLimits,
};

mod cache;
mod frame;
mod metadata;
pub use cache::{
    CacheStatistics, DecodeCache, FrameCache, FrameKey, Packet, PacketCache, PacketKey,
};
pub use frame::{DecodedFrame, GpuFrameDescriptor, GpuPixelFormat, GpuPlaneDescriptor};
pub use metadata::{
    ColorMetadata, ColorPrimaries, ContainerMetadata, MatrixCoefficients, MetadataLimits,
    StreamKind, StreamMetadata, Timebase, TransferFunction, VideoError,
};
#[cfg(test)]
mod tests;

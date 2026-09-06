use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::time::Duration;

use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportContainer {
    Mp4,
    Matroska,
}

impl ExportContainer {
    pub(super) fn muxer(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Matroska => "matroska",
        }
    }

    pub(super) fn extension(self) -> &'static str {
        match self {
            Self::Mp4 => "mp4",
            Self::Matroska => "mkv",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    Rgba8,
    Bgra8,
    Nv12,
    P010Le,
}

impl PixelFormat {
    pub(super) fn ffmpeg_name(self) -> &'static str {
        match self {
            Self::Rgba8 => "rgba",
            Self::Bgra8 => "bgra",
            Self::Nv12 => "nv12",
            Self::P010Le => "p010le",
        }
    }

    pub(super) fn frame_bytes(self, width: u32, height: u32) -> Option<u64> {
        let pixels = u64::from(width).checked_mul(u64::from(height))?;
        match self {
            Self::Rgba8 | Self::Bgra8 => pixels.checked_mul(4),
            Self::Nv12 => pixels.checked_mul(3)?.checked_div(2),
            Self::P010Le => pixels.checked_mul(3),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    H264,
    H265,
}

/// Explicit allow-list of FFmpeg encoders. H.265 is never selected implicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum VideoEncoder {
    H264Nvenc,
    H264Amf,
    H264Qsv,
    H264Vulkan,
    H264Software,
    H265Nvenc,
    H265Amf,
    H265Qsv,
    H265Vulkan,
    H265Software,
}

impl VideoEncoder {
    pub fn codec(self) -> VideoCodec {
        match self {
            Self::H264Nvenc
            | Self::H264Amf
            | Self::H264Qsv
            | Self::H264Vulkan
            | Self::H264Software => VideoCodec::H264,
            Self::H265Nvenc
            | Self::H265Amf
            | Self::H265Qsv
            | Self::H265Vulkan
            | Self::H265Software => VideoCodec::H265,
        }
    }

    pub fn ffmpeg_name(self) -> &'static str {
        match self {
            Self::H264Nvenc => "h264_nvenc",
            Self::H264Amf => "h264_amf",
            Self::H264Qsv => "h264_qsv",
            Self::H264Vulkan => "h264_vulkan",
            Self::H264Software => "libx264",
            Self::H265Nvenc => "hevc_nvenc",
            Self::H265Amf => "hevc_amf",
            Self::H265Qsv => "hevc_qsv",
            Self::H265Vulkan => "hevc_vulkan",
            Self::H265Software => "libx265",
        }
    }

    pub(super) fn from_ffmpeg_name(name: &str) -> Option<Self> {
        match name {
            "h264_nvenc" => Some(Self::H264Nvenc),
            "h264_amf" => Some(Self::H264Amf),
            "h264_qsv" => Some(Self::H264Qsv),
            "h264_vulkan" => Some(Self::H264Vulkan),
            "libx264" => Some(Self::H264Software),
            "hevc_nvenc" => Some(Self::H265Nvenc),
            "hevc_amf" => Some(Self::H265Amf),
            "hevc_qsv" => Some(Self::H265Qsv),
            "hevc_vulkan" => Some(Self::H265Vulkan),
            "libx265" => Some(Self::H265Software),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioEncoder {
    Aac,
    Opus,
}

impl AudioEncoder {
    pub(super) fn ffmpeg_name(self) -> &'static str {
        match self {
            Self::Aac => "aac",
            Self::Opus => "libopus",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioMuxSpec {
    pub source_path: PathBuf,
    /// Zero-based audio stream ordinal within the audio input.
    pub stream_index: u32,
    pub encoder: AudioEncoder,
    pub bitrate_bps: u32,
    pub sample_rate_hz: u32,
    pub channels: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoExportRequest {
    pub output_path: PathBuf,
    pub container: ExportContainer,
    pub encoder: VideoEncoder,
    pub input_format: PixelFormat,
    pub width: u32,
    pub height: u32,
    /// Frames per second numerator.
    pub frame_rate_numerator: u32,
    /// Frames per second denominator.
    pub frame_rate_denominator: u32,
    pub frame_count: u64,
    pub video_bitrate_bps: u64,
    pub audio: Option<AudioMuxSpec>,
}

/// One packed raw frame, or a bounded producer error.
pub type ExportFrame = Result<Vec<u8>, String>;

#[derive(Debug)]
pub(super) enum FrameMessage {
    Frame(ExportFrame),
    Finished,
}

/// The producer side of a bounded export queue.
///
/// This type is intentionally not cloneable: one producer must explicitly call
/// [`Self::finish`] after sending exactly the declared frame count.
#[derive(Debug)]
pub struct ExportFrameSender {
    sender: SyncSender<FrameMessage>,
}

impl ExportFrameSender {
    pub fn send_frame(&self, frame: ExportFrame) -> Result<(), ExportFrameSendError> {
        self.sender
            .send(FrameMessage::Frame(frame))
            .map_err(|_| ExportFrameSendError::ReceiverClosed)
    }

    pub fn finish(self) -> Result<(), ExportFrameSendError> {
        self.sender
            .send(FrameMessage::Finished)
            .map_err(|_| ExportFrameSendError::ReceiverClosed)
    }
}

#[derive(Debug)]
pub struct ExportFrameReceiver {
    pub(super) receiver: Receiver<FrameMessage>,
    pub(super) poll_interval: Duration,
    pub(super) max_error_bytes: usize,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ExportFrameSendError {
    #[error("export frame receiver is closed")]
    ReceiverClosed,
}

#[derive(Debug, Clone, clap::Args)]
pub struct ExportLimits {
    #[arg(long = "export-max-path-units", default_value_t = Self::default().max_path_units)]
    pub max_path_units: usize,
    #[arg(long = "export-max-audio-source-bytes", default_value_t = Self::default().max_audio_source_bytes)]
    pub max_audio_source_bytes: u64,
    #[arg(long = "export-encoder-probe-stdout-bytes", default_value_t = Self::default().encoder_probe_stdout_bytes)]
    pub encoder_probe_stdout_bytes: usize,
    #[arg(long = "export-max-frame-queue-capacity", default_value_t = Self::default().max_frame_queue_capacity)]
    pub max_frame_queue_capacity: usize,
    #[arg(long = "export-frame-poll-ms", default_value_t = Self::default().frame_poll_ms)]
    pub frame_poll_ms: u64,
    #[arg(long = "export-max-frame-error-bytes", default_value_t = Self::default().max_frame_error_bytes)]
    pub max_frame_error_bytes: usize,
    #[arg(long = "export-timeout-seconds", default_value = "14400", value_parser = |value: &str| value.parse::<u64>().map(Duration::from_secs))]
    pub timeout: Duration,
    #[arg(long = "export-encoder-probe-timeout-seconds", default_value = "15", value_parser = |value: &str| value.parse::<u64>().map(Duration::from_secs))]
    pub encoder_probe_timeout: Duration,
    #[arg(long = "export-max-stderr-bytes", default_value_t = Self::default().max_stderr_bytes)]
    pub max_stderr_bytes: usize,
    #[arg(long = "export-max-width", default_value_t = Self::default().max_width)]
    pub max_width: u32,
    #[arg(long = "export-max-height", default_value_t = Self::default().max_height)]
    pub max_height: u32,
    #[arg(long = "export-max-frame-bytes", default_value_t = Self::default().max_frame_bytes)]
    pub max_frame_bytes: u64,
    #[arg(long = "export-max-frame-count", default_value_t = Self::default().max_frame_count)]
    pub max_frame_count: u64,
    #[arg(long = "export-max-duration-seconds", default_value = "86400", value_parser = |value: &str| value.parse::<u64>().map(Duration::from_secs))]
    pub max_duration: Duration,
    #[arg(long = "export-max-video-bitrate-bps", default_value_t = Self::default().max_video_bitrate_bps)]
    pub max_video_bitrate_bps: u64,
    #[arg(long = "export-max-audio-bitrate-bps", default_value_t = Self::default().max_audio_bitrate_bps)]
    pub max_audio_bitrate_bps: u32,
}

impl Default for ExportLimits {
    fn default() -> Self {
        Self {
            max_path_units: 32_767,
            max_audio_source_bytes: 1024 * 1024 * 1024 * 1024,
            encoder_probe_stdout_bytes: 2 * 1024 * 1024,
            max_frame_queue_capacity: 64,
            frame_poll_ms: 5,
            max_frame_error_bytes: 1024,
            timeout: Duration::from_secs(4 * 60 * 60),
            encoder_probe_timeout: Duration::from_secs(15),
            max_stderr_bytes: 1024 * 1024,
            max_width: 16_384,
            max_height: 16_384,
            max_frame_bytes: 512 * 1024 * 1024,
            max_frame_count: 10_000_000,
            max_duration: Duration::from_secs(24 * 60 * 60),
            max_video_bitrate_bps: 1_000_000_000,
            max_audio_bitrate_bps: 1_000_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderAvailability {
    pub(super) encoders: BTreeSet<VideoEncoder>,
}

impl EncoderAvailability {
    /// Whether this FFmpeg build lists the encoder. This does not probe a GPU device.
    pub fn supports(&self, encoder: VideoEncoder) -> bool {
        self.encoders.contains(&encoder)
    }

    pub fn available(&self) -> impl Iterator<Item = VideoEncoder> + '_ {
        self.encoders.iter().copied()
    }

    /// Return the first compiled candidate in GPU-first order.
    ///
    /// Device initialization may still fail. Export never retries another encoder.
    pub fn preferred_compiled(&self, codec: VideoCodec) -> Option<VideoEncoder> {
        let candidates: &[VideoEncoder] = match codec {
            VideoCodec::H264 => &[
                VideoEncoder::H264Nvenc,
                VideoEncoder::H264Amf,
                VideoEncoder::H264Qsv,
                VideoEncoder::H264Vulkan,
                VideoEncoder::H264Software,
            ],
            VideoCodec::H265 => &[
                VideoEncoder::H265Nvenc,
                VideoEncoder::H265Amf,
                VideoEncoder::H265Qsv,
                VideoEncoder::H265Vulkan,
                VideoEncoder::H265Software,
            ],
        };
        candidates
            .iter()
            .copied()
            .find(|encoder| self.supports(*encoder))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportReport {
    pub output_path: PathBuf,
    pub encoder: VideoEncoder,
    pub frame_count: u64,
    pub bytes_written: u64,
    pub elapsed: Duration,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ExportError {
    #[error("invalid export request: {0}")]
    InvalidRequest(String),
    #[error("output already exists: {0}")]
    OutputExists(PathBuf),
    #[error("requested encoder {0} is unavailable")]
    EncoderUnavailable(&'static str),
    #[error("export was cancelled")]
    Cancelled,
    #[error("export exceeded its {timeout_ms} ms timeout")]
    TimedOut { timeout_ms: u64 },
    #[error("frame {index} contained {actual} bytes; expected {expected}")]
    InvalidFrameSize {
        index: u64,
        expected: usize,
        actual: usize,
    },
    #[error("frame source ended at frame {actual}; expected {expected}")]
    FrameCount { expected: u64, actual: u64 },
    #[error("frame source sent a frame after the declared {expected} frames")]
    ExtraFrame { expected: u64 },
    #[error("frame source disconnected without an explicit finish marker after {actual} frames")]
    FrameStreamUnfinished { actual: u64 },
    #[error("frame source failed at frame {index}: {message}")]
    FrameSource { index: u64, message: String },
    #[error("FFmpeg process I/O failed: {0}")]
    ProcessIo(String),
    #[error("FFmpeg stderr exceeded its {limit} byte limit")]
    StderrTooLarge { limit: usize },
    #[error("FFmpeg exited unsuccessfully ({code:?}): {stderr}")]
    ProcessFailed { code: Option<i32>, stderr: String },
    #[error("failed to publish encoded output: {0}")]
    Publish(String),
}

impl ExportLimits {
    /// Create a bounded single-producer frame channel.
    pub fn frame_channel(
        &self,
        capacity: usize,
    ) -> Result<(ExportFrameSender, ExportFrameReceiver), ExportError> {
        if capacity == 0 || capacity > self.max_frame_queue_capacity {
            return Err(ExportError::InvalidRequest(
                "frame queue capacity must be within the configured bounds".into(),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(capacity);
        Ok((
            ExportFrameSender { sender },
            ExportFrameReceiver {
                receiver,
                poll_interval: Duration::from_millis(self.frame_poll_ms),
                max_error_bytes: self.max_frame_error_bytes,
            },
        ))
    }
}

//! Process integration for FFprobe inspection and FFmpeg decoding.
//!
//! Commands are assembled as argument vectors and never passed through a shell.
//! Output is drained concurrently, retained within explicit bounds, and the child
//! is terminated when a timeout or cancellation request is observed.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Deserialize;
use thiserror::Error;

use crate::{
    ColorMetadata, ColorPrimaries, ContainerMetadata, DecodedFrame, GpuFrameDescriptor,
    GpuPixelFormat, MatrixCoefficients, StreamKind, StreamMetadata, Timebase, TransferFunction,
    VideoError,
};

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FfprobeError {
    #[error("media path is invalid: {0}")]
    InvalidMediaPath(&'static str),
    #[error("media file is larger than the configured {limit} byte limit")]
    MediaTooLarge { limit: u64 },
    #[error("failed to launch or communicate with media process: {0}")]
    ProcessIo(String),
    #[error("media process was cancelled")]
    Cancelled,
    #[error("media process exceeded its {timeout_ms} ms timeout")]
    TimedOut { timeout_ms: u64 },
    #[error("media process {stream} exceeded its {limit} byte limit")]
    OutputTooLarge { stream: &'static str, limit: usize },
    #[error("media process exited unsuccessfully ({code:?}): {stderr}")]
    ProcessFailed { code: Option<i32>, stderr: String },
    #[error("media metadata or decode request is invalid: {0}")]
    InvalidMetadata(String),
}

/// Shared process error for FFmpeg and FFprobe operations.
pub type FfmpegError = FfprobeError;

#[derive(Debug, Clone, clap::Args)]
pub struct ProbeLimits {
    #[command(flatten)]
    pub metadata: crate::MetadataLimits,
    #[arg(long = "probe-max-path-units", default_value_t = Self::default().max_path_units)]
    pub max_path_units: usize,
    #[arg(long = "probe-timeout-seconds", default_value = "15", value_parser = |value: &str| value.parse::<u64>().map(Duration::from_secs))]
    pub timeout: Duration,
    #[arg(long = "probe-max-stdout-bytes", default_value_t = Self::default().max_stdout_bytes)]
    pub max_stdout_bytes: usize,
    #[arg(long = "probe-max-stderr-bytes", default_value_t = Self::default().max_stderr_bytes)]
    pub max_stderr_bytes: usize,
    #[arg(long = "probe-max-media-bytes", default_value_t = Self::default().max_media_bytes)]
    pub max_media_bytes: u64,
}

impl Default for ProbeLimits {
    fn default() -> Self {
        Self {
            metadata: crate::MetadataLimits::default(),
            max_path_units: 32_767,
            timeout: Duration::from_secs(15),
            max_stdout_bytes: 1024 * 1024,
            max_stderr_bytes: 256 * 1024,
            max_media_bytes: 1024 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, clap::Args)]
pub struct DecodeLimits {
    #[command(flatten)]
    pub audio: crate::audio::AudioLimits,
    #[command(flatten)]
    pub metadata: crate::MetadataLimits,
    #[arg(long = "decode-max-path-units", default_value_t = Self::default().max_path_units)]
    pub max_path_units: usize,
    #[arg(long = "decode-timeout-seconds", default_value = "30", value_parser = |value: &str| value.parse::<u64>().map(Duration::from_secs))]
    pub timeout: Duration,
    #[arg(long = "decode-max-frame-bytes", default_value_t = Self::default().max_frame_bytes)]
    pub max_frame_bytes: usize,
    #[arg(long = "decode-max-audio-bytes", default_value_t = Self::default().max_audio_bytes)]
    pub max_audio_bytes: usize,
    #[arg(long = "decode-max-stderr-bytes", default_value_t = Self::default().max_stderr_bytes)]
    pub max_stderr_bytes: usize,
    #[arg(long = "decode-max-media-bytes", default_value_t = Self::default().max_media_bytes)]
    pub max_media_bytes: u64,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            audio: crate::audio::AudioLimits::default(),
            metadata: crate::MetadataLimits::default(),
            max_path_units: 32_767,
            timeout: Duration::from_secs(30),
            max_frame_bytes: 512 * 1024 * 1024,
            max_audio_bytes: 256 * 1024 * 1024,
            max_stderr_bytes: 256 * 1024,
            max_media_bytes: 1024 * 1024 * 1024 * 1024,
        }
    }
}

/// A cheap, cloneable cancellation flag suitable for UI task ownership.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

pub type FfprobeCommand = FfmpegCommand;

#[derive(Debug, Clone)]
pub struct FfprobeBackend {
    executable: PathBuf,
    limits: ProbeLimits,
}

impl Default for FfprobeBackend {
    fn default() -> Self {
        Self::new("ffprobe")
    }
}

impl FfprobeBackend {
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            limits: ProbeLimits::default(),
        }
    }

    pub fn with_limits(executable: impl Into<PathBuf>, limits: ProbeLimits) -> Self {
        Self {
            executable: executable.into(),
            limits,
        }
    }

    pub fn build_command(&self, media_path: &Path) -> Result<FfprobeCommand, FfprobeError> {
        FfmpegCommand::validate_media_path(
            media_path,
            self.limits.max_media_bytes,
            self.limits.max_path_units,
        )?;
        Ok(FfprobeCommand {
            executable: self.executable.clone(),
            arguments: vec![
                "-v".into(),
                "error".into(),
                "-print_format".into(),
                "json".into(),
                "-show_format".into(),
                "-show_streams".into(),
                "-i".into(),
                media_path.as_os_str().to_owned(),
            ],
        })
    }

    pub fn probe(
        &self,
        media_path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<ContainerMetadata, FfprobeError> {
        if cancellation.is_cancelled() {
            return Err(FfprobeError::Cancelled);
        }
        let command = self.build_command(media_path)?;
        let output = command
            .spawn(Stdio::null(), Stdio::piped())
            .map_err(|error| FfprobeError::ProcessIo(error.to_string()))?
            .capture(
                self.limits.timeout,
                self.limits.max_stdout_bytes,
                self.limits.max_stderr_bytes,
                cancellation,
            )?;
        if !output.status.success() {
            return Err(FfprobeError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        self.limits.parse_ffprobe_json(&output.stdout)
    }
}

/// Inspectable FFmpeg invocation whose arguments are never interpreted by a shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfmpegCommand {
    executable: PathBuf,
    arguments: Vec<OsString>,
}

impl FfmpegCommand {
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub(crate) fn spawn(&self, stdin: Stdio, stdout: Stdio) -> io::Result<MediaProcess> {
        Command::new(&self.executable)
            .args(&self.arguments)
            .stdin(stdin)
            .stdout(stdout)
            .stderr(Stdio::piped())
            .spawn()
            .map(|child| MediaProcess { child })
    }

    pub(crate) fn new(executable: PathBuf, arguments: Vec<OsString>) -> Self {
        Self {
            executable,
            arguments,
        }
    }
}

/// Real FFmpeg process backend for bounded, time-addressable media decode.
#[derive(Debug, Clone)]
pub struct FfmpegBackend {
    executable: PathBuf,
    limits: DecodeLimits,
}

impl Default for FfmpegBackend {
    fn default() -> Self {
        Self::new("ffmpeg")
    }
}

impl FfmpegBackend {
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            limits: DecodeLimits::default(),
        }
    }

    pub fn with_limits(executable: impl Into<PathBuf>, limits: DecodeLimits) -> Self {
        Self {
            executable: executable.into(),
            limits,
        }
    }

    pub(crate) fn executable(&self) -> &Path {
        &self.executable
    }

    pub(crate) fn limits(&self) -> &DecodeLimits {
        &self.limits
    }

    pub(crate) fn execute(
        &self,
        command: &FfmpegCommand,
        max_stdout_bytes: usize,
        cancellation: &CancellationToken,
    ) -> Result<ProcessOutput, FfmpegError> {
        let child = command
            .spawn(Stdio::null(), Stdio::piped())
            .map_err(|error| FfmpegError::ProcessIo(error.to_string()))?;
        child.capture(
            self.limits.timeout,
            max_stdout_bytes,
            self.limits.max_stderr_bytes,
            cancellation,
        )
    }

    pub fn build_decode_command(
        &self,
        media_path: &Path,
        stream_index: u32,
        time_seconds: f64,
    ) -> Result<FfmpegCommand, FfmpegError> {
        FfmpegCommand::validate_media_path(
            media_path,
            self.limits.max_media_bytes,
            self.limits.max_path_units,
        )?;
        if !time_seconds.is_finite() || time_seconds < 0.0 {
            return Err(FfmpegError::InvalidMetadata(
                "decode time must be finite and non-negative".into(),
            ));
        }
        Ok(FfmpegCommand {
            executable: self.executable.clone(),
            arguments: vec![
                "-v".into(),
                "error".into(),
                "-ss".into(),
                format!("{time_seconds:.9}").into(),
                "-i".into(),
                media_path.as_os_str().to_owned(),
                "-map".into(),
                format!("0:{stream_index}").into(),
                "-frames:v".into(),
                "1".into(),
                "-f".into(),
                "rawvideo".into(),
                "-pix_fmt".into(),
                "rgba".into(),
                "pipe:1".into(),
            ],
        })
    }

    pub fn decode_rgba_frame(
        &self,
        media_path: &Path,
        stream: &StreamMetadata,
        time_seconds: f64,
        cancellation: &CancellationToken,
    ) -> Result<DecodedFrame, FfmpegError> {
        if stream.kind != StreamKind::Video {
            return Err(FfmpegError::InvalidMetadata(
                "selected stream is not video".into(),
            ));
        }
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        let descriptor = GpuFrameDescriptor::aligned(
            stream.width,
            stream.height,
            GpuPixelFormat::Rgba8,
            stream.color,
            &self.limits.metadata,
        )
        .map_err(FfprobeError::from)?;
        let allocation_size = usize::try_from(descriptor.allocation_size)
            .map_err(|_| FfmpegError::InvalidMetadata("frame allocation overflow".into()))?;
        if allocation_size > self.limits.max_frame_bytes {
            return Err(FfmpegError::OutputTooLarge {
                stream: "stdout",
                limit: self.limits.max_frame_bytes,
            });
        }
        let packed_size =
            usize::try_from(u64::from(stream.width) * u64::from(stream.height) * 4)
                .map_err(|_| FfmpegError::InvalidMetadata("decoded frame size overflow".into()))?;
        let command = self.build_decode_command(media_path, stream.index, time_seconds)?;
        let child = command
            .spawn(Stdio::null(), Stdio::piped())
            .map_err(|error| FfmpegError::ProcessIo(error.to_string()))?;
        let output = child.capture(
            self.limits.timeout,
            packed_size,
            self.limits.max_stderr_bytes,
            cancellation,
        )?;
        if !output.status.success() {
            return Err(FfmpegError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        if output.stdout.len() != packed_size {
            return Err(FfmpegError::InvalidMetadata(format!(
                "decoded frame contained {} bytes; expected {packed_size}",
                output.stdout.len()
            )));
        }

        let packed_stride = usize::try_from(stream.width)
            .ok()
            .and_then(|width| width.checked_mul(4))
            .ok_or_else(|| FfmpegError::InvalidMetadata("frame stride overflow".into()))?;
        let aligned_stride = descriptor.planes[0].bytes_per_row as usize;
        let mut aligned = vec![0_u8; allocation_size];
        for (source, destination) in output
            .stdout
            .chunks_exact(packed_stride)
            .zip(aligned.chunks_exact_mut(aligned_stride))
        {
            destination[..packed_stride].copy_from_slice(source);
        }
        let duration = stream.frame_rate.map_or(0, |rate| {
            rate.rescale(1, stream.timebase).unwrap_or(0).max(0)
        });
        Ok(DecodedFrame {
            descriptor,
            duration,
            bytes: Arc::from(aligned),
        })
    }
}

use crate::process::{MediaProcess, ProcessOutput};
mod probe;
#[cfg(test)]
mod tests;

impl FfmpegCommand {
    pub(crate) fn validate_media_path(
        path: &Path,
        max_media_bytes: u64,
        max_path_units: usize,
    ) -> Result<(), FfprobeError> {
        if path.as_os_str().is_empty() {
            return Err(FfprobeError::InvalidMediaPath("path is empty"));
        }
        if path.as_os_str().to_string_lossy().encode_utf16().count() > max_path_units {
            return Err(FfprobeError::InvalidMediaPath("path is too long"));
        }
        let metadata = path
            .metadata()
            .map_err(|_| FfprobeError::InvalidMediaPath("file does not exist"))?;
        if !metadata.is_file() {
            return Err(FfprobeError::InvalidMediaPath("path is not a regular file"));
        }
        if metadata.len() > max_media_bytes {
            return Err(FfprobeError::MediaTooLarge {
                limit: max_media_bytes,
            });
        }
        Ok(())
    }
}

impl From<VideoError> for FfprobeError {
    fn from(error: VideoError) -> Self {
        Self::InvalidMetadata(error.to_string())
    }
}

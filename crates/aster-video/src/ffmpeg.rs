//! Sandboxed process integration for FFprobe inspection and FFmpeg decoding.
//!
//! Commands are assembled as argument vectors and never passed through a shell.
//! Output is drained concurrently, retained within explicit bounds, and the child
//! is terminated when a timeout or cancellation request is observed.

use std::ffi::OsString;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use thiserror::Error;

use crate::{
    ColorMetadata, ColorPrimaries, ContainerMetadata, DecodedFrame, GpuFrameDescriptor,
    GpuPixelFormat, MatrixCoefficients, StreamKind, StreamMetadata, Timebase, TransferFunction,
    VideoError,
};

const CONTAINER_TIMEBASE_DENOMINATOR: u32 = 1_000_000_000;
const MAX_PATH_UNITS: usize = 32_767;

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

#[derive(Debug, Clone)]
pub struct ProbeLimits {
    pub timeout: Duration,
    pub max_stdout_bytes: usize,
    pub max_stderr_bytes: usize,
    pub max_media_bytes: u64,
}

impl Default for ProbeLimits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(15),
            max_stdout_bytes: 1024 * 1024,
            max_stderr_bytes: 256 * 1024,
            max_media_bytes: 1024 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DecodeLimits {
    pub timeout: Duration,
    pub max_frame_bytes: usize,
    pub max_audio_bytes: usize,
    pub max_stderr_bytes: usize,
    pub max_media_bytes: u64,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
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

/// Inspectable FFprobe invocation. Arguments remain distinct OS strings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FfprobeCommand {
    executable: PathBuf,
    arguments: Vec<OsString>,
}

impl FfprobeCommand {
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    fn spawn(&self) -> io::Result<std::process::Child> {
        Command::new(&self.executable)
            .args(&self.arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    }
}

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
        validate_media_path(media_path, self.limits.max_media_bytes)?;
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
        let output = run_bounded(&command, &self.limits, cancellation)?;
        if !output.status.success() {
            return Err(FfprobeError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        parse_ffprobe_json(&output.stdout)
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

    fn spawn(&self) -> io::Result<std::process::Child> {
        Command::new(&self.executable)
            .args(&self.arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
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
            .spawn()
            .map_err(|error| FfmpegError::ProcessIo(error.to_string()))?;
        run_child(
            child,
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
        validate_media_path(media_path, self.limits.max_media_bytes)?;
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
        let packed_size =
            usize::try_from(u64::from(stream.width) * u64::from(stream.height) * 4)
                .map_err(|_| FfmpegError::InvalidMetadata("decoded frame size overflow".into()))?;
        if packed_size == 0 || packed_size > self.limits.max_frame_bytes {
            return Err(FfmpegError::OutputTooLarge {
                stream: "stdout",
                limit: self.limits.max_frame_bytes,
            });
        }
        let command = self.build_decode_command(media_path, stream.index, time_seconds)?;
        let child = command
            .spawn()
            .map_err(|error| FfmpegError::ProcessIo(error.to_string()))?;
        let output = run_child(
            child,
            self.limits.timeout,
            self.limits.max_frame_bytes,
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

        let descriptor = GpuFrameDescriptor::aligned(
            stream.width,
            stream.height,
            GpuPixelFormat::Rgba8,
            stream.color,
        )
        .map_err(map_video_error)?;
        let allocation_size = usize::try_from(descriptor.allocation_size)
            .map_err(|_| FfmpegError::InvalidMetadata("frame allocation overflow".into()))?;
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

pub(crate) fn validate_media_path(path: &Path, max_media_bytes: u64) -> Result<(), FfprobeError> {
    if path.as_os_str().is_empty() {
        return Err(FfprobeError::InvalidMediaPath("path is empty"));
    }
    if path.as_os_str().to_string_lossy().encode_utf16().count() > MAX_PATH_UNITS {
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

pub(crate) struct ProcessOutput {
    pub(crate) status: ExitStatus,
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
}

struct BoundedRead {
    bytes: Vec<u8>,
    overflowed: bool,
}

fn read_bounded(mut reader: impl Read, limit: usize) -> io::Result<BoundedRead> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut overflowed = false;
    let mut chunk = [0_u8; 16 * 1024];
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        bytes.extend_from_slice(&chunk[..count.min(remaining)]);
        overflowed |= count > remaining;
    }
    Ok(BoundedRead { bytes, overflowed })
}

fn run_bounded(
    command: &FfprobeCommand,
    limits: &ProbeLimits,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, FfprobeError> {
    let child = command
        .spawn()
        .map_err(|error| FfprobeError::ProcessIo(error.to_string()))?;
    run_child(
        child,
        limits.timeout,
        limits.max_stdout_bytes,
        limits.max_stderr_bytes,
        cancellation,
    )
}

fn run_child(
    mut child: std::process::Child,
    timeout: Duration,
    max_stdout_bytes: usize,
    max_stderr_bytes: usize,
    cancellation: &CancellationToken,
) -> Result<ProcessOutput, FfprobeError> {
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| FfprobeError::ProcessIo("stdout pipe was unavailable".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| FfprobeError::ProcessIo("stderr pipe was unavailable".into()))?;
    let stdout_limit = max_stdout_bytes;
    let stderr_limit = max_stderr_bytes;
    let stdout_reader = thread::spawn(move || read_bounded(stdout, stdout_limit));
    let stderr_reader = thread::spawn(move || read_bounded(stderr, stderr_limit));
    let started = Instant::now();

    let status = loop {
        if cancellation.is_cancelled() {
            terminate(&mut child);
            join_readers(stdout_reader, stderr_reader)?;
            return Err(FfprobeError::Cancelled);
        }
        if started.elapsed() >= timeout {
            terminate(&mut child);
            join_readers(stdout_reader, stderr_reader)?;
            return Err(FfprobeError::TimedOut {
                timeout_ms: u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => thread::sleep(Duration::from_millis(2)),
            Err(error) => {
                terminate(&mut child);
                join_readers(stdout_reader, stderr_reader)?;
                return Err(FfprobeError::ProcessIo(error.to_string()));
            }
        }
    };

    let (stdout, stderr) = join_readers(stdout_reader, stderr_reader)?;
    if stdout.overflowed {
        return Err(FfprobeError::OutputTooLarge {
            stream: "stdout",
            limit: max_stdout_bytes,
        });
    }
    if stderr.overflowed {
        return Err(FfprobeError::OutputTooLarge {
            stream: "stderr",
            limit: max_stderr_bytes,
        });
    }
    Ok(ProcessOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

fn terminate(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

type Reader = thread::JoinHandle<io::Result<BoundedRead>>;

fn join_readers(
    stdout: Reader,
    stderr: Reader,
) -> Result<(BoundedRead, BoundedRead), FfprobeError> {
    let stdout = stdout
        .join()
        .map_err(|_| FfprobeError::ProcessIo("stdout reader panicked".into()))?
        .map_err(|error| FfprobeError::ProcessIo(error.to_string()))?;
    let stderr = stderr
        .join()
        .map_err(|_| FfprobeError::ProcessIo("stderr reader panicked".into()))?
        .map_err(|error| FfprobeError::ProcessIo(error.to_string()))?;
    Ok((stdout, stderr))
}

#[derive(Debug, Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: RawFormat,
}

#[derive(Debug, Deserialize)]
struct RawFormat {
    format_name: String,
    #[serde(default)]
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawStream {
    index: u32,
    codec_type: String,
    #[serde(default)]
    codec_name: Option<String>,
    #[serde(default)]
    time_base: Option<String>,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    avg_frame_rate: Option<String>,
    #[serde(default)]
    color_primaries: Option<String>,
    #[serde(default)]
    color_transfer: Option<String>,
    #[serde(default)]
    color_space: Option<String>,
    #[serde(default)]
    color_range: Option<String>,
    #[serde(default)]
    disposition: RawDisposition,
}

#[derive(Debug, Default, Deserialize)]
struct RawDisposition {
    #[serde(default)]
    default: u8,
}

/// Convert bounded FFprobe JSON into Aster's decoder-independent metadata model.
pub fn parse_ffprobe_json(bytes: &[u8]) -> Result<ContainerMetadata, FfprobeError> {
    if bytes.len() > 1024 * 1024 {
        return Err(FfprobeError::OutputTooLarge {
            stream: "stdout",
            limit: 1024 * 1024,
        });
    }
    let raw: RawProbe = serde_json::from_slice(bytes)
        .map_err(|error| FfprobeError::InvalidMetadata(error.to_string()))?;
    if raw.streams.len() > 128 {
        return Err(FfprobeError::InvalidMetadata("too many streams".into()));
    }
    let duration_ticks = parse_duration_ticks(raw.format.duration.as_deref())?;
    let streams = raw
        .streams
        .into_iter()
        .map(convert_stream)
        .collect::<Result<Vec<_>, _>>()?;
    let metadata = ContainerMetadata {
        format: normalize_format(&raw.format.format_name)?,
        duration_ticks,
        timebase: Timebase::new(1, CONTAINER_TIMEBASE_DENOMINATOR).map_err(map_video_error)?,
        streams,
    };
    // Reuse the public validator without maintaining a second set of invariants.
    let encoded = serde_json::to_vec(&metadata)
        .map_err(|error| FfprobeError::InvalidMetadata(error.to_string()))?;
    crate::probe_metadata(&encoded).map_err(map_video_error)
}

fn convert_stream(raw: RawStream) -> Result<StreamMetadata, FfprobeError> {
    let timebase = match raw.time_base.as_deref() {
        Some(value) if value != "N/A" => parse_rational(value, false)?,
        _ => Timebase::new(1, CONTAINER_TIMEBASE_DENOMINATOR).map_err(map_video_error)?,
    };
    let frame_rate = match raw.avg_frame_rate.as_deref() {
        None | Some("0/0") | Some("N/A") => None,
        Some(value) => Some(parse_rational(value, true)?),
    };
    Ok(StreamMetadata {
        index: raw.index,
        kind: match raw.codec_type.as_str() {
            "video" => StreamKind::Video,
            "audio" => StreamKind::Audio,
            "subtitle" => StreamKind::Subtitle,
            _ => StreamKind::Data,
        },
        codec: normalize_token(raw.codec_name.as_deref().unwrap_or("unknown"), "codec")?,
        timebase,
        default: raw.disposition.default != 0,
        width: raw.width,
        height: raw.height,
        frame_rate,
        color: ColorMetadata {
            primaries: match raw.color_primaries.as_deref() {
                Some("bt709") => ColorPrimaries::Bt709,
                Some("bt2020") => ColorPrimaries::Bt2020,
                Some("smpte432") => ColorPrimaries::DisplayP3,
                _ => ColorPrimaries::Unspecified,
            },
            transfer: match raw.color_transfer.as_deref() {
                Some("iec61966-2-1") => TransferFunction::Srgb,
                Some("bt709" | "bt601" | "smpte170m") => TransferFunction::Bt709,
                Some("smpte2084") => TransferFunction::Pq,
                Some("arib-std-b67") => TransferFunction::Hlg,
                Some("linear") => TransferFunction::Linear,
                _ => TransferFunction::Unspecified,
            },
            matrix: match raw.color_space.as_deref() {
                Some("gbr" | "rgb") => MatrixCoefficients::Identity,
                Some("bt709") => MatrixCoefficients::Bt709,
                Some("bt2020nc") => MatrixCoefficients::Bt2020NonConstant,
                _ => MatrixCoefficients::Unspecified,
            },
            full_range: matches!(raw.color_range.as_deref(), Some("pc" | "jpeg")),
        },
    })
}

fn parse_duration_ticks(duration: Option<&str>) -> Result<i64, FfprobeError> {
    let Some(duration) = duration.filter(|value| *value != "N/A") else {
        return Ok(0);
    };
    let seconds = duration
        .parse::<f64>()
        .map_err(|_| FfprobeError::InvalidMetadata("invalid duration".into()))?;
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(FfprobeError::InvalidMetadata("invalid duration".into()));
    }
    let ticks = seconds * f64::from(CONTAINER_TIMEBASE_DENOMINATOR);
    if ticks > i64::MAX as f64 {
        return Err(FfprobeError::InvalidMetadata("duration overflow".into()));
    }
    Ok(ticks.round() as i64)
}

fn parse_rational(value: &str, reciprocal: bool) -> Result<Timebase, FfprobeError> {
    let (left, right) = value
        .split_once('/')
        .ok_or_else(|| FfprobeError::InvalidMetadata("invalid rational".into()))?;
    let numerator = left
        .parse::<u32>()
        .map_err(|_| FfprobeError::InvalidMetadata("invalid rational".into()))?;
    let denominator = right
        .parse::<u32>()
        .map_err(|_| FfprobeError::InvalidMetadata("invalid rational".into()))?;
    let (numerator, denominator) = if reciprocal {
        (denominator, numerator)
    } else {
        (numerator, denominator)
    };
    Timebase::new(numerator, denominator).map_err(map_video_error)
}

fn normalize_format(value: &str) -> Result<String, FfprobeError> {
    normalize_token(value.split(',').next().unwrap_or_default(), "format")
}

fn normalize_token(value: &str, field: &'static str) -> Result<String, FfprobeError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        return Err(FfprobeError::InvalidMetadata(format!(
            "invalid {field} name"
        )));
    }
    Ok(value.to_owned())
}

fn map_video_error(error: VideoError) -> FfprobeError {
    FfprobeError::InvalidMetadata(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;

    const SAMPLE: &[u8] = br#"{
      "streams": [
        {
          "index": 0, "codec_name": "hevc", "codec_type": "video",
          "width": 3840, "height": 2160, "time_base": "1/90000",
          "avg_frame_rate": "30000/1001", "color_range": "pc",
          "color_space": "bt2020nc", "color_transfer": "smpte2084",
          "color_primaries": "bt2020", "disposition": {"default": 1}
        },
        {
          "index": 1, "codec_name": "aac", "codec_type": "audio",
          "time_base": "1/48000"
        }
      ],
      "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "12.345000"}
    }"#;

    #[test]
    fn parses_ffprobe_streams_color_and_timebases() {
        let metadata = parse_ffprobe_json(SAMPLE).expect("valid fixture");
        assert_eq!(metadata.format, "mov");
        assert_eq!(metadata.duration_ticks, 12_345_000_000);
        assert_eq!(metadata.streams.len(), 2);
        let video = &metadata.streams[0];
        assert_eq!(video.timebase, Timebase::new(1, 90_000).unwrap());
        assert_eq!(video.frame_rate, Some(Timebase::new(1001, 30_000).unwrap()));
        assert_eq!(video.color.primaries, ColorPrimaries::Bt2020);
        assert_eq!(video.color.transfer, TransferFunction::Pq);
        assert_eq!(video.color.matrix, MatrixCoefficients::Bt2020NonConstant);
        assert!(video.color.full_range);
        assert!(video.default);
    }

    #[test]
    fn rejects_malformed_and_unbounded_probe_data() {
        assert!(matches!(
            parse_ffprobe_json(br#"{"format":{"format_name":"mp4","duration":"NaN"}}"#),
            Err(FfprobeError::InvalidMetadata(_))
        ));
        assert!(matches!(
            parse_ffprobe_json(&vec![b' '; 1024 * 1024 + 1]),
            Err(FfprobeError::OutputTooLarge { .. })
        ));
    }

    #[test]
    fn bounded_reader_drains_but_does_not_retain_excess_output() {
        let result = read_bounded(&b"0123456789"[..], 4).unwrap();
        assert_eq!(result.bytes, b"0123");
        assert!(result.overflowed);
    }

    #[test]
    fn builds_argument_vector_without_shell_interpretation() {
        let root = std::env::temp_dir().join(format!("aster-ffprobe-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let media = root.join("clip;$(touch injected).mp4");
        File::create(&media).unwrap();
        let command = FfprobeBackend::default().build_command(&media).unwrap();
        assert_eq!(command.executable(), Path::new("ffprobe"));
        assert_eq!(command.arguments().last(), Some(&media.into_os_string()));
        let decode = FfmpegBackend::default()
            .build_decode_command(&root.join("clip;$(touch injected).mp4"), 7, 1.25)
            .unwrap();
        assert_eq!(decode.executable(), Path::new("ffmpeg"));
        assert!(decode.arguments().contains(&"0:7".into()));
        assert!(decode.arguments().contains(&"1.250000000".into()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn honours_pre_cancelled_requests_without_launching() {
        let root = std::env::temp_dir().join(format!("aster-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let media = root.join("clip.mp4");
        File::create(&media).unwrap();
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert_eq!(
            FfprobeBackend::new("definitely-not-an-executable").probe(&media, &cancellation),
            Err(FfprobeError::Cancelled)
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "requires ffmpeg and ffprobe on PATH"]
    fn probes_a_real_generated_container() {
        let root = std::env::temp_dir().join(format!("aster-real-probe-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let media = root.join("fixture.mkv");
        let status = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=16x16:d=0.04",
                "-frames:v",
                "1",
                "-c:v",
                "ffv1",
                "-y",
            ])
            .arg(&media)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .expect("ffmpeg must be available for this ignored test");
        assert!(status.success());

        let metadata = FfprobeBackend::default()
            .probe(&media, &CancellationToken::default())
            .expect("generated container must probe");
        let video = crate::select_video_stream(&metadata).expect("video stream");
        assert_eq!((video.width, video.height), (16, 16));
        let frame = FfmpegBackend::default()
            .decode_rgba_frame(&media, video, 0.0, &CancellationToken::default())
            .expect("generated frame must decode");
        assert_eq!(frame.descriptor.format, GpuPixelFormat::Rgba8);
        assert_eq!(frame.bytes.len() as u64, frame.descriptor.allocation_size);
        assert_eq!(frame.descriptor.planes[0].bytes_per_row % 256, 0);
        assert!(frame.bytes.iter().any(|byte| *byte != 0));
        let _ = std::fs::remove_dir_all(root);
    }
}

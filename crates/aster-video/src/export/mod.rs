//! Bounded FFmpeg export with streamed raw frames and atomic publication.
//!
//! The boundary accepts only typed codec/container choices and constructs an OS
//! argument vector. Frame bytes are fed on a dedicated thread while stderr is
//! drained concurrently, so a verbose or failed encoder cannot deadlock export.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use crate::{CancellationToken, FfmpegCommand};

mod process;
mod spec;

use process::{
    join_reader, monitor_process, process_failed, process_io, spawn_reader, write_frames,
};

pub use spec::{
    AudioEncoder, AudioMuxSpec, EncoderAvailability, ExportContainer, ExportError, ExportFrame,
    ExportFrameReceiver, ExportFrameSendError, ExportFrameSender, ExportLimits, ExportReport,
    PixelFormat, VideoCodec, VideoEncoder, VideoExportRequest, bounded_frame_channel,
};

const MAX_PATH_UNITS: usize = 32_767;
const MAX_AUDIO_SOURCE_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const ENCODER_PROBE_STDOUT_BYTES: usize = 2 * 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct FfmpegExportBackend {
    executable: PathBuf,
    limits: ExportLimits,
}

impl Default for FfmpegExportBackend {
    fn default() -> Self {
        Self::new("ffmpeg")
    }
}

impl FfmpegExportBackend {
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            limits: ExportLimits::default(),
        }
    }

    pub fn with_limits(executable: impl Into<PathBuf>, limits: ExportLimits) -> Self {
        Self {
            executable: executable.into(),
            limits,
        }
    }

    /// List encoders compiled into FFmpeg; this does not prove a device can initialize.
    pub fn probe_compiled_encoders(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<EncoderAvailability, ExportError> {
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        let command = FfmpegCommand::new(
            self.executable.clone(),
            vec!["-hide_banner".into(), "-encoders".into()],
        );
        let mut child = Command::new(command.executable())
            .args(command.arguments())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(process_io)?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| process_io("stdout pipe unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| process_io("stderr pipe unavailable"))?;
        let stdout_reader = spawn_reader(stdout, ENCODER_PROBE_STDOUT_BYTES);
        let stderr_limit = self.limits.max_stderr_bytes;
        let stderr_reader = spawn_reader(stderr, stderr_limit);
        let status = monitor_process(
            &mut child,
            self.limits.encoder_probe_timeout,
            cancellation,
            None,
        );
        let stdout = join_reader(stdout_reader)?;
        let stderr = join_reader(stderr_reader)?;
        let status = status?;
        if stdout.overflowed {
            return Err(ExportError::ProcessIo(
                "FFmpeg encoder list exceeded its 2 MiB limit".into(),
            ));
        }
        if stderr.overflowed {
            return Err(ExportError::StderrTooLarge {
                limit: self.limits.max_stderr_bytes,
            });
        }
        if !status.success() {
            return Err(process_failed(status.code(), &stderr.bytes));
        }
        Ok(parse_encoder_availability(&stdout.bytes))
    }

    pub fn export(
        &self,
        request: &VideoExportRequest,
        frames: ExportFrameReceiver,
        cancellation: &CancellationToken,
    ) -> Result<ExportReport, ExportError> {
        let validated = validate_request(request, &self.limits)?;
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        let availability = self.probe_compiled_encoders(cancellation)?;
        if !availability.supports(request.encoder) {
            return Err(ExportError::EncoderUnavailable(
                request.encoder.ffmpeg_name(),
            ));
        }

        let temporary = TemporaryOutput::create(&request.output_path, request.container)?;
        let command = self.build_command(request, &validated, temporary.path());
        let started = Instant::now();
        self.run_export(
            &command,
            frames,
            validated.frame_bytes,
            request.frame_count,
            cancellation,
        )?;
        temporary.publish(&request.output_path)?;
        let bytes_written = request
            .output_path
            .metadata()
            .map_err(|error| ExportError::Publish(error.to_string()))?
            .len();
        Ok(ExportReport {
            output_path: request.output_path.clone(),
            encoder: request.encoder,
            frame_count: request.frame_count,
            bytes_written,
            elapsed: started.elapsed(),
        })
    }

    fn build_command(
        &self,
        request: &VideoExportRequest,
        validated: &ValidatedExport,
        destination: &Path,
    ) -> FfmpegCommand {
        let mut arguments: Vec<OsString> = vec![
            "-hide_banner".into(),
            "-v".into(),
            "error".into(),
            "-nostdin".into(),
            "-f".into(),
            "rawvideo".into(),
            "-pix_fmt".into(),
            request.input_format.ffmpeg_name().into(),
            "-video_size".into(),
            format!("{}x{}", request.width, request.height).into(),
            "-framerate".into(),
            format!(
                "{}/{}",
                request.frame_rate_numerator, request.frame_rate_denominator
            )
            .into(),
            "-i".into(),
            "pipe:0".into(),
        ];
        if let Some(audio) = &request.audio {
            arguments.extend(["-i".into(), audio.source_path.as_os_str().to_owned()]);
        }
        arguments.extend([
            "-map".into(),
            "0:v:0".into(),
            "-c:v".into(),
            request.encoder.ffmpeg_name().into(),
            "-b:v".into(),
            request.video_bitrate_bps.to_string().into(),
            "-pix_fmt".into(),
            output_pixel_format(request).into(),
            "-frames:v".into(),
            request.frame_count.to_string().into(),
            "-sn".into(),
            "-dn".into(),
        ]);
        if let Some(audio) = &request.audio {
            arguments.extend([
                "-map".into(),
                format!("1:a:{}", audio.stream_index).into(),
                "-c:a".into(),
                audio.encoder.ffmpeg_name().into(),
                "-b:a".into(),
                audio.bitrate_bps.to_string().into(),
                "-ar".into(),
                audio.sample_rate_hz.to_string().into(),
                "-ac".into(),
                audio.channels.to_string().into(),
                "-t".into(),
                format!("{:.9}", validated.duration_seconds).into(),
            ]);
        } else {
            arguments.push("-an".into());
        }
        if request.container == ExportContainer::Mp4 {
            if request.encoder.codec() == VideoCodec::H265 {
                arguments.extend(["-tag:v".into(), "hvc1".into()]);
            }
            arguments.extend(["-movflags".into(), "+faststart".into()]);
        }
        arguments.extend([
            "-f".into(),
            request.container.muxer().into(),
            "-n".into(),
            destination.as_os_str().to_owned(),
        ]);
        FfmpegCommand::new(self.executable.clone(), arguments)
    }

    fn run_export(
        &self,
        command: &FfmpegCommand,
        frames: ExportFrameReceiver,
        frame_bytes: usize,
        frame_count: u64,
        cancellation: &CancellationToken,
    ) -> Result<(), ExportError> {
        let mut child = Command::new(command.executable())
            .args(command.arguments())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(process_io)?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| process_io("stdin pipe unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| process_io("stderr pipe unavailable"))?;
        let stderr_limit = self.limits.max_stderr_bytes;
        let stderr_reader = spawn_reader(stderr, stderr_limit);
        let writer_shutdown = CancellationToken::default();
        let writer_control = writer_shutdown.clone();
        let (writer_tx, writer_rx) = mpsc::sync_channel(1);
        let writer = thread::spawn(move || {
            let result = write_frames(stdin, frames, frame_bytes, frame_count, &writer_control);
            if result.is_err() {
                let _ = writer_tx.send(());
            }
            result
        });

        let status = monitor_process(
            &mut child,
            self.limits.timeout,
            cancellation,
            Some(&writer_rx),
        );
        // Child exit, timeout, and user cancellation all release a writer waiting
        // for its next bounded channel message before we join it.
        writer_shutdown.cancel();
        let writer_result = writer
            .join()
            .map_err(|_| process_io("frame writer panicked"))?;
        let stderr = join_reader(stderr_reader)?;
        if matches!(
            &status,
            Err(ExportError::Cancelled | ExportError::TimedOut { .. })
        ) {
            return status.map(|_| ());
        }
        if stderr.overflowed {
            return Err(ExportError::StderrTooLarge {
                limit: self.limits.max_stderr_bytes,
            });
        }
        if let Ok(status) = &status
            && !status.success()
        {
            return Err(process_failed(status.code(), &stderr.bytes));
        }
        writer_result?;
        let status = status?;
        debug_assert!(status.success());
        Ok(())
    }
}

#[derive(Debug)]
struct ValidatedExport {
    frame_bytes: usize,
    duration_seconds: f64,
}

fn validate_request(
    request: &VideoExportRequest,
    limits: &ExportLimits,
) -> Result<ValidatedExport, ExportError> {
    validate_output_path(&request.output_path, request.container)?;
    if request.width == 0
        || request.height == 0
        || request.width > limits.max_width
        || request.height > limits.max_height
    {
        return Err(invalid("dimensions exceed the configured bounds"));
    }
    if !request.width.is_multiple_of(2) || !request.height.is_multiple_of(2) {
        return Err(invalid("4:2:0 output dimensions must be even"));
    }
    let frame_bytes = request
        .input_format
        .frame_bytes(request.width, request.height)
        .ok_or_else(|| invalid("frame byte count overflowed"))?;
    if frame_bytes == 0 || frame_bytes > limits.max_frame_bytes {
        return Err(invalid("frame byte count exceeds the configured bound"));
    }
    if request.frame_rate_numerator == 0 || request.frame_rate_denominator == 0 {
        return Err(invalid("frame rate must be a positive rational"));
    }
    let frames_per_second =
        f64::from(request.frame_rate_numerator) / f64::from(request.frame_rate_denominator);
    if !(1.0..=240.0).contains(&frames_per_second) {
        return Err(invalid("frame rate must be between 1 and 240 fps"));
    }
    if request.frame_count == 0 || request.frame_count > limits.max_frame_count {
        return Err(invalid("frame count exceeds the configured bound"));
    }
    let duration_seconds = request.frame_count as f64 / frames_per_second;
    if !duration_seconds.is_finite() || duration_seconds > limits.max_duration.as_secs_f64() {
        return Err(invalid("duration exceeds the configured bound"));
    }
    if !(64_000..=limits.max_video_bitrate_bps).contains(&request.video_bitrate_bps) {
        return Err(invalid("video bitrate exceeds the configured bounds"));
    }
    if request.encoder.codec() == VideoCodec::H265 && request.container == ExportContainer::Mp4 {
        // This path remains supported, but selecting it is explicit in `encoder`.
    }
    if let Some(audio) = &request.audio {
        validate_audio(audio, request.container, limits)?;
    }
    Ok(ValidatedExport {
        frame_bytes: usize::try_from(frame_bytes)
            .map_err(|_| invalid("frame byte count cannot be represented"))?,
        duration_seconds,
    })
}

fn validate_output_path(path: &Path, container: ExportContainer) -> Result<(), ExportError> {
    if path.as_os_str().is_empty()
        || path.as_os_str().to_string_lossy().encode_utf16().count() > MAX_PATH_UNITS
    {
        return Err(invalid("output path is empty or too long"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("output path must have a UTF-8 extension"))?;
    if !extension.eq_ignore_ascii_case(container.extension()) {
        return Err(invalid("output extension does not match the container"));
    }
    if path.exists() {
        return Err(ExportError::OutputExists(path.to_owned()));
    }
    let parent = output_parent(path);
    let metadata = parent
        .metadata()
        .map_err(|_| invalid("output parent does not exist"))?;
    if !metadata.is_dir() {
        return Err(invalid("output parent is not a directory"));
    }
    Ok(())
}

fn validate_audio(
    audio: &AudioMuxSpec,
    container: ExportContainer,
    limits: &ExportLimits,
) -> Result<(), ExportError> {
    if audio.source_path.as_os_str().is_empty()
        || audio
            .source_path
            .as_os_str()
            .to_string_lossy()
            .encode_utf16()
            .count()
            > MAX_PATH_UNITS
    {
        return Err(invalid("audio source path is empty or too long"));
    }
    let metadata = audio
        .source_path
        .metadata()
        .map_err(|_| invalid("audio source does not exist"))?;
    if !metadata.is_file() || metadata.len() > MAX_AUDIO_SOURCE_BYTES {
        return Err(invalid("audio source is not a bounded regular file"));
    }
    if audio.stream_index >= 128 {
        return Err(invalid("audio stream index exceeds the bound"));
    }
    if !(8_000..=192_000).contains(&audio.sample_rate_hz) {
        return Err(invalid(
            "audio sample rate must be between 8 kHz and 192 kHz",
        ));
    }
    if !(1..=32).contains(&audio.channels) {
        return Err(invalid("audio channel count must be between 1 and 32"));
    }
    if !(16_000..=limits.max_audio_bitrate_bps).contains(&audio.bitrate_bps) {
        return Err(invalid("audio bitrate exceeds the configured bounds"));
    }
    if container == ExportContainer::Mp4 && audio.encoder != AudioEncoder::Aac {
        return Err(invalid("MP4 export requires AAC audio"));
    }
    Ok(())
}

fn output_pixel_format(request: &VideoExportRequest) -> &'static str {
    if request.encoder.codec() == VideoCodec::H265 && request.input_format == PixelFormat::P010Le {
        "yuv420p10le"
    } else {
        "yuv420p"
    }
}

fn parse_encoder_availability(bytes: &[u8]) -> EncoderAvailability {
    let text = String::from_utf8_lossy(bytes);
    let encoders = text
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let flags = columns.next()?;
            let name = columns.next()?;
            (flags.starts_with('V') || flags.starts_with('.'))
                .then(|| VideoEncoder::from_ffmpeg_name(name))
                .flatten()
        })
        .collect();
    EncoderAvailability { encoders }
}

fn invalid(message: impl Into<String>) -> ExportError {
    ExportError::InvalidRequest(message.into())
}

fn output_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

struct TemporaryOutput {
    directory: PathBuf,
    path: PathBuf,
}

impl TemporaryOutput {
    fn create(output: &Path, container: ExportContainer) -> Result<Self, ExportError> {
        let parent = output_parent(output);
        for _ in 0..128 {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let directory = parent.join(format!(".aster-export-{}-{sequence}", std::process::id()));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    let path = directory.join(format!("encoded.{}", container.extension()));
                    return Ok(Self { directory, path });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(ExportError::ProcessIo(error.to_string())),
            }
        }
        Err(ExportError::ProcessIo(
            "could not reserve a temporary export directory".into(),
        ))
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn publish(self, output: &Path) -> Result<(), ExportError> {
        match fs::hard_link(&self.path, output) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                return Err(ExportError::OutputExists(output.to_owned()));
            }
            Err(error) => return Err(ExportError::Publish(error.to_string())),
        }
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
        Ok(())
    }
}

impl Drop for TemporaryOutput {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

#[cfg(test)]
mod tests;

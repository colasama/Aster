//! Bounded FFmpeg export with streamed raw frames and atomic publication.
//!
//! The boundary accepts only typed codec/container choices and constructs an OS
//! argument vector. Frame bytes are fed on a dedicated thread while stderr is
//! drained concurrently, so a verbose or failed encoder cannot deadlock export.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;

use crate::{CancellationToken, FfmpegCommand};

mod process;
mod spec;

use crate::process::BoundedRead;
use aster_storage::AtomicFile;

pub use spec::{
    AudioEncoder, AudioMuxSpec, EncoderAvailability, ExportContainer, ExportError, ExportFrame,
    ExportFrameReceiver, ExportFrameSendError, ExportFrameSender, ExportLimits, ExportReport,
    PixelFormat, VideoCodec, VideoEncoder, VideoExportRequest,
};

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
        let output = command
            .spawn(Stdio::null(), Stdio::piped())
            .map_err(ExportError::from)?
            .capture(
                self.limits.encoder_probe_timeout,
                self.limits.encoder_probe_stdout_bytes,
                self.limits.max_stderr_bytes,
                cancellation,
            )
            .map_err(ExportError::from)?;
        if !output.status.success() {
            return Err(ExportError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        Ok(EncoderAvailability::parse(&output.stdout))
    }

    pub fn export(
        &self,
        request: &VideoExportRequest,
        frames: ExportFrameReceiver,
        cancellation: &CancellationToken,
    ) -> Result<ExportReport, ExportError> {
        let validated = request.validate(&self.limits)?;
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        let availability = self.probe_compiled_encoders(cancellation)?;
        if !availability.supports(request.encoder) {
            return Err(ExportError::EncoderUnavailable(
                request.encoder.ffmpeg_name(),
            ));
        }

        let (temporary, file) =
            AtomicFile::stage(&request.output_path).map_err(ExportError::from)?;
        drop(file);
        let command = self.build_command(request, &validated, &temporary.temporary);
        let started = Instant::now();
        self.run_export(
            &command,
            frames,
            validated.frame_bytes,
            request.frame_count,
            cancellation,
        )?;
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        let bytes_written = fs::metadata(&temporary.temporary)
            .map_err(ExportError::from)?
            .len();
        if bytes_written == 0 {
            return Err(ExportError::Publish(
                "encoder produced an empty output".into(),
            ));
        }
        temporary.publish(false).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                ExportError::OutputExists(request.output_path.clone())
            } else {
                ExportError::Publish(error.to_string())
            }
        })?;
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
            request.output_pixel_format().into(),
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
            "-y".into(),
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
        let mut child = command
            .spawn(Stdio::piped(), Stdio::null())
            .map_err(ExportError::from)?;
        let stdin = child
            .child
            .stdin
            .take()
            .ok_or_else(|| ExportError::ProcessIo("stdin pipe unavailable".into()))?;
        let stderr = child
            .child
            .stderr
            .take()
            .ok_or_else(|| ExportError::ProcessIo("stderr pipe unavailable".into()))?;
        let stderr_limit = self.limits.max_stderr_bytes;
        let stderr_reader = BoundedRead::spawn(stderr, stderr_limit);
        let writer_shutdown = CancellationToken::default();
        let writer_control = writer_shutdown.clone();
        let (writer_tx, writer_rx) = mpsc::sync_channel(1);
        let writer = thread::spawn(move || {
            let result = ExportFrameReceiver::write_frames(
                stdin,
                frames,
                frame_bytes,
                frame_count,
                &writer_control,
            );
            if result.is_err() {
                let _ = writer_tx.send(());
            }
            result
        });

        let status = child
            .monitor(self.limits.timeout, cancellation, Some(&writer_rx))
            .map_err(ExportError::from);
        // Child exit, timeout, and user cancellation all release a writer waiting
        // for its next bounded channel message before we join it.
        writer_shutdown.cancel();
        let writer_result = writer
            .join()
            .map_err(|_| ExportError::ProcessIo("frame writer panicked".into()));
        let stderr = BoundedRead::join(stderr_reader).map_err(ExportError::from);
        let writer_result = writer_result?;
        let stderr = stderr?;
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
            return Err(ExportError::ProcessFailed {
                code: status.code(),
                stderr: String::from_utf8_lossy(&stderr.bytes).trim().to_owned(),
            });
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

#[cfg(test)]
mod tests;

impl VideoExportRequest {
    fn validate(&self, limits: &ExportLimits) -> Result<ValidatedExport, ExportError> {
        self.validate_output_path(limits)?;
        if self.width == 0
            || self.height == 0
            || self.width > limits.max_width
            || self.height > limits.max_height
        {
            return Err(ExportError::InvalidRequest(
                "dimensions exceed the configured bounds".into(),
            ));
        }
        if !self.width.is_multiple_of(2) || !self.height.is_multiple_of(2) {
            return Err(ExportError::InvalidRequest(
                "4:2:0 output dimensions must be even".into(),
            ));
        }
        let frame_bytes = self
            .input_format
            .frame_bytes(self.width, self.height)
            .ok_or_else(|| ExportError::InvalidRequest("frame byte count overflowed".into()))?;
        if frame_bytes == 0 || frame_bytes > limits.max_frame_bytes {
            return Err(ExportError::InvalidRequest(
                "frame byte count exceeds the configured bound".into(),
            ));
        }
        if self.frame_rate_numerator == 0 || self.frame_rate_denominator == 0 {
            return Err(ExportError::InvalidRequest(
                "frame rate must be a positive rational".into(),
            ));
        }
        let frames_per_second =
            f64::from(self.frame_rate_numerator) / f64::from(self.frame_rate_denominator);
        if !(1.0..=240.0).contains(&frames_per_second) {
            return Err(ExportError::InvalidRequest(
                "frame rate must be between 1 and 240 fps".into(),
            ));
        }
        if self.frame_count == 0 || self.frame_count > limits.max_frame_count {
            return Err(ExportError::InvalidRequest(
                "frame count exceeds the configured bound".into(),
            ));
        }
        let duration_seconds = self.frame_count as f64 / frames_per_second;
        if !duration_seconds.is_finite() || duration_seconds > limits.max_duration.as_secs_f64() {
            return Err(ExportError::InvalidRequest(
                "duration exceeds the configured bound".into(),
            ));
        }
        if !(64_000..=limits.max_video_bitrate_bps).contains(&self.video_bitrate_bps) {
            return Err(ExportError::InvalidRequest(
                "video bitrate exceeds the configured bounds".into(),
            ));
        }
        if let Some(audio) = &self.audio {
            audio.validate(self.container, limits)?;
        }
        Ok(ValidatedExport {
            frame_bytes: usize::try_from(frame_bytes).map_err(|_| {
                ExportError::InvalidRequest("frame byte count cannot be represented".into())
            })?,
            duration_seconds,
        })
    }
}

impl VideoExportRequest {
    fn validate_output_path(&self, limits: &ExportLimits) -> Result<(), ExportError> {
        let path = &self.output_path;
        if path.as_os_str().is_empty()
            || path.as_os_str().to_string_lossy().encode_utf16().count() > limits.max_path_units
        {
            return Err(ExportError::InvalidRequest(
                "output path is empty or too long".into(),
            ));
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                ExportError::InvalidRequest("output path must have a UTF-8 extension".into())
            })?;
        if !extension.eq_ignore_ascii_case(self.container.extension()) {
            return Err(ExportError::InvalidRequest(
                "output extension does not match the container".into(),
            ));
        }
        if path.exists() {
            return Err(ExportError::OutputExists(path.to_owned()));
        }
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let metadata = parent
            .metadata()
            .map_err(|_| ExportError::InvalidRequest("output parent does not exist".into()))?;
        if !metadata.is_dir() {
            return Err(ExportError::InvalidRequest(
                "output parent is not a directory".into(),
            ));
        }
        Ok(())
    }
}

impl AudioMuxSpec {
    fn validate(
        &self,
        container: ExportContainer,
        limits: &ExportLimits,
    ) -> Result<(), ExportError> {
        if self.source_path.as_os_str().is_empty()
            || self
                .source_path
                .as_os_str()
                .to_string_lossy()
                .encode_utf16()
                .count()
                > limits.max_path_units
        {
            return Err(ExportError::InvalidRequest(
                "audio source path is empty or too long".into(),
            ));
        }
        let metadata = self
            .source_path
            .metadata()
            .map_err(|_| ExportError::InvalidRequest("audio source does not exist".into()))?;
        if !metadata.is_file() || metadata.len() > limits.max_audio_source_bytes {
            return Err(ExportError::InvalidRequest(
                "audio source is not a bounded regular file".into(),
            ));
        }
        if self.stream_index >= 128 {
            return Err(ExportError::InvalidRequest(
                "audio stream index exceeds the bound".into(),
            ));
        }
        if !(8_000..=192_000).contains(&self.sample_rate_hz) {
            return Err(ExportError::InvalidRequest(
                "audio sample rate must be between 8 kHz and 192 kHz".into(),
            ));
        }
        if !(1..=32).contains(&self.channels) {
            return Err(ExportError::InvalidRequest(
                "audio channel count must be between 1 and 32".into(),
            ));
        }
        if !(16_000..=limits.max_audio_bitrate_bps).contains(&self.bitrate_bps) {
            return Err(ExportError::InvalidRequest(
                "audio bitrate exceeds the configured bounds".into(),
            ));
        }
        if container == ExportContainer::Mp4 && self.encoder != AudioEncoder::Aac {
            return Err(ExportError::InvalidRequest(
                "MP4 export requires AAC audio".into(),
            ));
        }
        Ok(())
    }
}

impl VideoExportRequest {
    fn output_pixel_format(&self) -> &'static str {
        if self.encoder.codec() == VideoCodec::H265 && self.input_format == PixelFormat::P010Le {
            "yuv420p10le"
        } else {
            "yuv420p"
        }
    }
}

impl EncoderAvailability {
    fn parse(bytes: &[u8]) -> EncoderAvailability {
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
}

impl From<io::Error> for ExportError {
    fn from(error: io::Error) -> Self {
        Self::ProcessIo(error.to_string())
    }
}
impl From<crate::FfmpegError> for ExportError {
    fn from(error: crate::FfmpegError) -> Self {
        match error {
            crate::FfmpegError::Cancelled => Self::Cancelled,
            crate::FfmpegError::TimedOut { timeout_ms } => Self::TimedOut { timeout_ms },
            crate::FfmpegError::OutputTooLarge {
                stream: "stderr",
                limit,
            } => Self::StderrTooLarge { limit },
            crate::FfmpegError::ProcessIo(message) => Self::ProcessIo(message),
            error => Self::ProcessIo(error.to_string()),
        }
    }
}

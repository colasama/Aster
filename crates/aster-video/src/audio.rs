//! Bounded FFmpeg audio decode into interleaved floating-point PCM.

use std::path::Path;
use std::sync::Arc;

use crate::{
    CancellationToken, FfmpegBackend, FfmpegCommand, FfmpegError, StreamKind, StreamMetadata,
};

#[derive(Debug, Clone, clap::Args)]
pub struct AudioLimits {
    #[arg(long, default_value_t = Self::default().max_audio_sample_rate)]
    pub max_audio_sample_rate: u32,
    #[arg(long, default_value_t = Self::default().max_audio_channels)]
    pub max_audio_channels: u16,
    #[arg(long, default_value_t = Self::default().max_audio_end_seconds)]
    pub max_audio_end_seconds: f64,
    #[arg(long, default_value_t = Self::default().max_audio_duration_seconds)]
    pub max_audio_duration_seconds: f64,
}
impl Default for AudioLimits {
    fn default() -> Self {
        Self {
            max_audio_sample_rate: 192_000,
            max_audio_channels: 8,
            max_audio_end_seconds: 604_800.0,
            max_audio_duration_seconds: 300.0,
        }
    }
}

/// Time-addressed, explicitly converted audio decode parameters.
///
/// The duration limit intentionally encourages short preview/cache segments instead of
/// retaining an entire source in CPU memory. Samples are converted by FFmpeg to the
/// requested canonical layout so downstream playback never has to interpret a codec's
/// native sample format.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AudioDecodeRequest {
    pub start_seconds: f64,
    pub duration_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
}

impl AudioDecodeRequest {
    /// A 48 kHz stereo preview segment beginning at the requested media time.
    pub fn preview(start_seconds: f64, duration_seconds: f64) -> Self {
        Self {
            start_seconds,
            duration_seconds,
            sample_rate: 48_000,
            channels: 2,
        }
    }

    fn output_byte_limit(self, limits: &crate::DecodeLimits) -> Result<usize, FfmpegError> {
        if !self.start_seconds.is_finite() || self.start_seconds < 0.0 {
            return Err(FfmpegError::InvalidMetadata(
                "audio start time must be finite and non-negative".into(),
            ));
        }
        if !self.duration_seconds.is_finite()
            || self.duration_seconds <= 0.0
            || self.duration_seconds > limits.audio.max_audio_duration_seconds
        {
            return Err(FfmpegError::InvalidMetadata(
                "audio duration must be positive and within the configured limit".into(),
            ));
        }
        let end = self.start_seconds + self.duration_seconds;
        if !end.is_finite() || end > limits.audio.max_audio_end_seconds {
            return Err(FfmpegError::InvalidMetadata(
                "audio decode range must end within the configured limit".into(),
            ));
        }
        if !(8_000..=limits.audio.max_audio_sample_rate).contains(&self.sample_rate) {
            return Err(FfmpegError::InvalidMetadata(
                "audio sample rate must be within the configured bounds".into(),
            ));
        }
        if !(1..=limits.audio.max_audio_channels).contains(&self.channels) {
            return Err(FfmpegError::InvalidMetadata(
                "audio channel count must be within the configured bounds".into(),
            ));
        }

        let frames = (self.duration_seconds * f64::from(self.sample_rate)).ceil() as u64;
        let bytes = frames
            .checked_mul(u64::from(self.channels))
            .and_then(|samples| samples.checked_mul(size_of::<f32>() as u64))
            .and_then(|bytes| usize::try_from(bytes).ok())
            .ok_or_else(|| FfmpegError::InvalidMetadata("audio output size overflow".into()))?;
        let limit = limits.max_audio_bytes;
        if bytes == 0 || bytes > limit {
            return Err(FfmpegError::OutputTooLarge {
                stream: "stdout",
                limit,
            });
        }
        Ok(bytes)
    }
}

/// Canonical, interleaved `f32` PCM suitable for a preview ring buffer or GPU upload.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    pub start_seconds: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Arc<[f32]>,
}

impl DecodedAudio {
    pub fn frame_count(&self) -> usize {
        if self.channels == 0 {
            return 0;
        }
        self.samples.len() / usize::from(self.channels)
    }

    pub fn duration_seconds(&self) -> f64 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.frame_count() as f64 / f64::from(self.sample_rate)
    }
}

impl FfmpegBackend {
    /// Build a shell-free FFmpeg command for canonical interleaved `f32le` PCM.
    pub fn build_audio_decode_command(
        &self,
        media_path: &Path,
        stream_index: u32,
        request: AudioDecodeRequest,
    ) -> Result<FfmpegCommand, FfmpegError> {
        FfmpegCommand::validate_media_path(
            media_path,
            self.limits().max_media_bytes,
            self.limits().max_path_units,
        )?;
        request.output_byte_limit(self.limits())?;
        Ok(FfmpegCommand::new(
            self.executable().to_owned(),
            vec![
                "-nostdin".into(),
                "-v".into(),
                "error".into(),
                "-ss".into(),
                format!("{:.9}", request.start_seconds).into(),
                "-i".into(),
                media_path.as_os_str().to_owned(),
                "-map".into(),
                format!("0:{stream_index}").into(),
                "-t".into(),
                format!("{:.9}", request.duration_seconds).into(),
                "-vn".into(),
                "-sn".into(),
                "-dn".into(),
                "-ac".into(),
                request.channels.to_string().into(),
                "-ar".into(),
                request.sample_rate.to_string().into(),
                "-f".into(),
                "f32le".into(),
                "-acodec".into(),
                "pcm_f32le".into(),
                "pipe:1".into(),
            ],
        ))
    }

    /// Decode one bounded audio range, terminating FFmpeg on timeout or cancellation.
    pub fn decode_audio(
        &self,
        media_path: &Path,
        stream: &StreamMetadata,
        request: AudioDecodeRequest,
        cancellation: &CancellationToken,
    ) -> Result<DecodedAudio, FfmpegError> {
        if stream.kind != StreamKind::Audio {
            return Err(FfmpegError::InvalidMetadata(
                "selected stream is not audio".into(),
            ));
        }
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        let output_limit = request.output_byte_limit(self.limits())?;
        let command = self.build_audio_decode_command(media_path, stream.index, request)?;
        let output = self.execute(&command, output_limit, cancellation)?;
        if !output.status.success() {
            return Err(FfmpegError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        let frame_bytes = usize::from(request.channels) * size_of::<f32>();
        if output.stdout.len() % frame_bytes != 0 {
            return Err(FfmpegError::InvalidMetadata(
                "decoded audio ended with an incomplete PCM frame".into(),
            ));
        }
        let samples = DecodedAudio::decode_f32le(&output.stdout)?;
        Ok(DecodedAudio {
            start_seconds: request.start_seconds,
            sample_rate: request.sample_rate,
            channels: request.channels,
            samples: Arc::from(samples),
        })
    }
}

impl DecodedAudio {
    fn decode_f32le(bytes: &[u8]) -> Result<Vec<f32>, FfmpegError> {
        if !bytes.len().is_multiple_of(size_of::<f32>()) {
            return Err(FfmpegError::InvalidMetadata("incomplete PCM sample".into()));
        }
        let mut samples = Vec::with_capacity(bytes.len() / size_of::<f32>());
        for bytes in bytes.chunks_exact(size_of::<f32>()) {
            let sample = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            if !sample.is_finite() {
                return Err(FfmpegError::InvalidMetadata(
                    "decoded audio contains a non-finite sample".into(),
                ));
            }
            samples.push(sample);
        }
        Ok(samples)
    }
}

#[cfg(test)]
mod tests;

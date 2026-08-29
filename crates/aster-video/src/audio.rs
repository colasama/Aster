//! Bounded FFmpeg audio decode into interleaved floating-point PCM.

use std::path::Path;
use std::sync::Arc;

use crate::ffmpeg::validate_media_path;
use crate::{
    CancellationToken, FfmpegBackend, FfmpegCommand, FfmpegError, StreamKind, StreamMetadata,
};

const MIN_SAMPLE_RATE: u32 = 8_000;
const MAX_SAMPLE_RATE: u32 = 192_000;
const MAX_CHANNELS: u16 = 8;
const MAX_END_SECONDS: f64 = 7.0 * 24.0 * 60.0 * 60.0;
const MAX_DURATION_SECONDS: f64 = 5.0 * 60.0;
const BYTES_PER_SAMPLE: u64 = size_of::<f32>() as u64;
const ABSOLUTE_MAX_OUTPUT_BYTES: usize = 512 * 1024 * 1024;

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

    fn output_byte_limit(self, configured_limit: usize) -> Result<usize, FfmpegError> {
        if !self.start_seconds.is_finite() || self.start_seconds < 0.0 {
            return Err(invalid("audio start time must be finite and non-negative"));
        }
        if !self.duration_seconds.is_finite()
            || self.duration_seconds <= 0.0
            || self.duration_seconds > MAX_DURATION_SECONDS
        {
            return Err(invalid("audio duration must be within (0, 300] seconds"));
        }
        let end = self.start_seconds + self.duration_seconds;
        if !end.is_finite() || end > MAX_END_SECONDS {
            return Err(invalid("audio decode range must end within seven days"));
        }
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&self.sample_rate) {
            return Err(invalid("audio sample rate must be within 8000..=192000 Hz"));
        }
        if !(1..=MAX_CHANNELS).contains(&self.channels) {
            return Err(invalid("audio channel count must be within 1..=8"));
        }

        let frames = (self.duration_seconds * f64::from(self.sample_rate)).ceil() as u64;
        let bytes = frames
            .checked_mul(u64::from(self.channels))
            .and_then(|samples| samples.checked_mul(BYTES_PER_SAMPLE))
            .and_then(|bytes| usize::try_from(bytes).ok())
            .ok_or_else(|| invalid("audio output size overflow"))?;
        let limit = configured_limit.min(ABSOLUTE_MAX_OUTPUT_BYTES);
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
        validate_media_path(media_path, self.limits().max_media_bytes)?;
        request.output_byte_limit(self.limits().max_audio_bytes)?;
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
            return Err(invalid("selected stream is not audio"));
        }
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        let output_limit = request.output_byte_limit(self.limits().max_audio_bytes)?;
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
            return Err(invalid("decoded audio ended with an incomplete PCM frame"));
        }
        let samples = decode_f32le(&output.stdout)?;
        Ok(DecodedAudio {
            start_seconds: request.start_seconds,
            sample_rate: request.sample_rate,
            channels: request.channels,
            samples: Arc::from(samples),
        })
    }
}

fn decode_f32le(bytes: &[u8]) -> Result<Vec<f32>, FfmpegError> {
    let mut samples = Vec::with_capacity(bytes.len() / size_of::<f32>());
    for bytes in bytes.chunks_exact(size_of::<f32>()) {
        let sample = f32::from_le_bytes(bytes.try_into().expect("four-byte chunk"));
        if !sample.is_finite() {
            return Err(invalid("decoded audio contains a non-finite sample"));
        }
        samples.push(sample);
    }
    Ok(samples)
}

fn invalid(message: &str) -> FfmpegError {
    FfmpegError::InvalidMetadata(message.into())
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::fs::File;
    use std::process::{Command, Stdio};

    use super::*;
    use crate::{ColorMetadata, DecodeLimits, Timebase};

    fn audio_stream(index: u32) -> StreamMetadata {
        StreamMetadata {
            index,
            kind: StreamKind::Audio,
            codec: "pcm_s16le".into(),
            timebase: Timebase::new(1, 48_000).unwrap(),
            default: true,
            width: 0,
            height: 0,
            frame_rate: None,
            sample_rate: 48_000,
            channels: 2,
            color: ColorMetadata::default(),
        }
    }

    struct Fixture(std::path::PathBuf);

    impl Fixture {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(root) = self.0.parent() {
                let _ = std::fs::remove_dir_all(root);
            }
        }
    }

    fn fixture_path(label: &str) -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "aster-audio-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("clip;$(touch ignored).wav");
        File::create(&path).unwrap();
        Fixture(path)
    }

    #[test]
    fn builds_bounded_shell_free_audio_command() {
        let media = fixture_path("command");
        let request = AudioDecodeRequest::preview(1.25, 0.5);
        let command = FfmpegBackend::default()
            .build_audio_decode_command(media.path(), 3, request)
            .unwrap();
        assert_eq!(command.executable(), Path::new("ffmpeg"));
        assert_eq!(command.arguments().last(), Some(&OsString::from("pipe:1")));
        assert!(command.arguments().contains(&OsString::from("0:3")));
        assert!(
            command
                .arguments()
                .contains(&media.path().as_os_str().to_owned())
        );
    }

    #[test]
    fn rejects_every_unbounded_request_dimension_before_launch() {
        let media = fixture_path("limits");
        let backend = FfmpegBackend::new("definitely-not-an-executable");
        let invalid = [
            AudioDecodeRequest::preview(-1.0, 1.0),
            AudioDecodeRequest::preview(0.0, 301.0),
            AudioDecodeRequest::preview(MAX_END_SECONDS, 1.0),
            AudioDecodeRequest {
                sample_rate: 7_999,
                ..AudioDecodeRequest::preview(0.0, 1.0)
            },
            AudioDecodeRequest {
                channels: 9,
                ..AudioDecodeRequest::preview(0.0, 1.0)
            },
        ];
        for request in invalid {
            assert!(matches!(
                backend.decode_audio(
                    media.path(),
                    &audio_stream(0),
                    request,
                    &CancellationToken::default()
                ),
                Err(FfmpegError::InvalidMetadata(_))
            ));
        }
    }

    #[test]
    fn enforces_configured_output_bytes_before_launch() {
        let media = fixture_path("bytes");
        let backend = FfmpegBackend::with_limits(
            "definitely-not-an-executable",
            DecodeLimits {
                max_audio_bytes: 32,
                ..DecodeLimits::default()
            },
        );
        assert_eq!(
            backend.decode_audio(
                media.path(),
                &audio_stream(0),
                AudioDecodeRequest::preview(0.0, 1.0),
                &CancellationToken::default()
            ),
            Err(FfmpegError::OutputTooLarge {
                stream: "stdout",
                limit: 32
            })
        );
    }

    #[test]
    fn rejects_wrong_stream_and_pre_cancelled_decode() {
        let media = fixture_path("cancel");
        let backend = FfmpegBackend::new("definitely-not-an-executable");
        let request = AudioDecodeRequest::preview(0.0, 0.1);
        let mut video = audio_stream(0);
        video.kind = StreamKind::Video;
        assert!(matches!(
            backend.decode_audio(media.path(), &video, request, &CancellationToken::default()),
            Err(FfmpegError::InvalidMetadata(_))
        ));
        let cancellation = CancellationToken::default();
        cancellation.cancel();
        assert_eq!(
            backend.decode_audio(media.path(), &audio_stream(0), request, &cancellation),
            Err(FfmpegError::Cancelled)
        );
    }

    #[test]
    fn converts_little_endian_pcm_and_rejects_non_finite_samples() {
        let bytes = [0.25_f32.to_le_bytes(), (-0.5_f32).to_le_bytes()].concat();
        assert_eq!(decode_f32le(&bytes).unwrap(), [0.25, -0.5]);
        assert!(matches!(
            decode_f32le(&f32::NAN.to_le_bytes()),
            Err(FfmpegError::InvalidMetadata(_))
        ));
    }

    #[test]
    #[ignore = "requires ffmpeg on PATH"]
    fn decodes_a_real_generated_audio_range() {
        let media = fixture_path("real");
        let status = Command::new("ffmpeg")
            .args([
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=0.25",
                "-c:a",
                "pcm_s16le",
                "-y",
            ])
            .arg(media.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .status()
            .expect("ffmpeg must be available for this ignored test");
        assert!(status.success());

        let audio = FfmpegBackend::default()
            .decode_audio(
                media.path(),
                &audio_stream(0),
                AudioDecodeRequest {
                    start_seconds: 0.05,
                    duration_seconds: 0.1,
                    sample_rate: 24_000,
                    channels: 1,
                },
                &CancellationToken::default(),
            )
            .expect("generated audio must decode");
        assert_eq!(audio.sample_rate, 24_000);
        assert_eq!(audio.channels, 1);
        assert!((2_399..=2_400).contains(&audio.frame_count()));
        assert!(audio.samples.iter().any(|sample| sample.abs() > 0.01));
        assert!(audio.samples.iter().all(|sample| sample.is_finite()));
    }
}

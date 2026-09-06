use std::ffi::OsString;
use std::fs::File;
use std::process::{Command, Stdio};

use super::*;
use crate::{ColorMetadata, DecodeLimits, Timebase};

impl StreamMetadata {
    fn audio_fixture(index: u32) -> StreamMetadata {
        StreamMetadata {
            index,
            kind: StreamKind::Audio,
            codec: "pcm_s16le".into(),
            timebase: Timebase {
                numerator: 1,
                denominator: 48_000,
            },
            default: true,
            width: 0,
            height: 0,
            frame_rate: None,
            sample_rate: 48_000,
            channels: 2,
            color: ColorMetadata::default(),
        }
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

impl Fixture {
    fn create(label: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "aster-audio-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&root)?;
        let path = root.join("clip;$(touch ignored).wav");
        File::create(&path)?;
        Ok(Self(path))
    }
}

#[test]
fn builds_bounded_shell_free_audio_command() -> Result<(), Box<dyn std::error::Error>> {
    let media = Fixture::create("command")?;
    let request = AudioDecodeRequest::preview(1.25, 0.5);
    let command = FfmpegBackend::default().build_audio_decode_command(media.path(), 3, request)?;
    assert_eq!(command.executable(), Path::new("ffmpeg"));
    assert_eq!(command.arguments().last(), Some(&OsString::from("pipe:1")));
    assert!(command.arguments().contains(&OsString::from("0:3")));
    assert!(
        command
            .arguments()
            .contains(&media.path().as_os_str().to_owned())
    );
    Ok(())
}

#[test]
fn rejects_every_unbounded_request_dimension_before_launch()
-> Result<(), Box<dyn std::error::Error>> {
    let media = Fixture::create("limits")?;
    let backend = FfmpegBackend::new("definitely-not-an-executable");
    let invalid = [
        AudioDecodeRequest::preview(-1.0, 1.0),
        AudioDecodeRequest::preview(0.0, 301.0),
        AudioDecodeRequest::preview(AudioLimits::default().max_audio_end_seconds, 1.0),
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
                &StreamMetadata::audio_fixture(0),
                request,
                &CancellationToken::default()
            ),
            Err(FfmpegError::InvalidMetadata(_))
        ));
    }
    Ok(())
}

#[test]
fn enforces_configured_output_bytes_before_launch() -> Result<(), Box<dyn std::error::Error>> {
    let media = Fixture::create("bytes")?;
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
            &StreamMetadata::audio_fixture(0),
            AudioDecodeRequest::preview(0.0, 1.0),
            &CancellationToken::default()
        ),
        Err(FfmpegError::OutputTooLarge {
            stream: "stdout",
            limit: 32
        })
    );
    Ok(())
}

#[test]
fn rejects_wrong_stream_and_pre_cancelled_decode() -> Result<(), Box<dyn std::error::Error>> {
    let media = Fixture::create("cancel")?;
    let backend = FfmpegBackend::new("definitely-not-an-executable");
    let request = AudioDecodeRequest::preview(0.0, 0.1);
    let mut video = StreamMetadata::audio_fixture(0);
    video.kind = StreamKind::Video;
    assert!(matches!(
        backend.decode_audio(media.path(), &video, request, &CancellationToken::default()),
        Err(FfmpegError::InvalidMetadata(_))
    ));
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert_eq!(
        backend.decode_audio(
            media.path(),
            &StreamMetadata::audio_fixture(0),
            request,
            &cancellation
        ),
        Err(FfmpegError::Cancelled)
    );
    Ok(())
}

#[test]
fn converts_little_endian_pcm_and_rejects_non_finite_samples()
-> Result<(), Box<dyn std::error::Error>> {
    let bytes = [0.25_f32.to_le_bytes(), (-0.5_f32).to_le_bytes()].concat();
    assert_eq!(DecodedAudio::decode_f32le(&bytes)?, [0.25, -0.5]);
    assert!(matches!(
        DecodedAudio::decode_f32le(&f32::NAN.to_le_bytes()),
        Err(FfmpegError::InvalidMetadata(_))
    ));
    Ok(())
}

#[test]
#[ignore = "requires ffmpeg on PATH"]
fn decodes_a_real_generated_audio_range() -> Result<(), Box<dyn std::error::Error>> {
    let media = Fixture::create("real")?;
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
        .status()?;
    assert!(status.success());

    let audio = FfmpegBackend::default().decode_audio(
        media.path(),
        &StreamMetadata::audio_fixture(0),
        AudioDecodeRequest {
            start_seconds: 0.05,
            duration_seconds: 0.1,
            sample_rate: 24_000,
            channels: 1,
        },
        &CancellationToken::default(),
    )?;
    assert_eq!(audio.sample_rate, 24_000);
    assert_eq!(audio.channels, 1);
    assert!((2_399..=2_400).contains(&audio.frame_count()));
    assert!(audio.samples.iter().any(|sample| sample.abs() > 0.01));
    assert!(audio.samples.iter().all(|sample| sample.is_finite()));
    Ok(())
}

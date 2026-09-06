use super::*;
use crate::process::MediaProcess;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

impl VideoExportRequest {
    fn test_root(name: &str) -> PathBuf {
        let sequence = uuid::Uuid::new_v4();
        std::env::temp_dir().join(format!(
            "aster-export-test-{name}-{}-{sequence}",
            std::process::id()
        ))
    }
}

impl VideoExportRequest {
    fn fixture(root: &Path) -> VideoExportRequest {
        VideoExportRequest {
            output_path: root.join("clip.mp4"),
            container: ExportContainer::Mp4,
            encoder: VideoEncoder::H264Software,
            input_format: PixelFormat::Rgba8,
            width: 16,
            height: 16,
            frame_rate_numerator: 30,
            frame_rate_denominator: 1,
            frame_count: 2,
            video_bitrate_bps: 500_000,
            audio: None,
        }
    }
}

impl ExportFrameReceiver {
    fn fixture(frames: Vec<ExportFrame>) -> Result<Self, Box<dyn std::error::Error>> {
        let (sender, receiver) = ExportLimits::default().frame_channel(frames.len() + 1)?;
        for frame in frames {
            sender.send_frame(frame)?;
        }
        sender.finish()?;
        Ok(receiver)
    }
}

#[test]
fn validates_frame_geometry_rate_duration_and_container() -> Result<(), Box<dyn std::error::Error>>
{
    let root = VideoExportRequest::test_root("validation");
    fs::create_dir_all(&root)?;
    let limits = ExportLimits::default();
    let mut value = VideoExportRequest::fixture(&root);
    assert_eq!(value.validate(&limits)?.frame_bytes, 1024);
    value.width = 15;
    assert!(matches!(
        value.validate(&limits),
        Err(ExportError::InvalidRequest(_))
    ));
    value.width = 16;
    value.frame_rate_numerator = 1000;
    assert!(value.validate(&limits).is_err());
    value.frame_rate_numerator = 30;
    value.output_path.set_extension("mkv");
    assert!(value.validate(&limits).is_err());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn validates_bitrate_duration_output_and_audio_bounds() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("request-bounds");
    fs::create_dir_all(&root)?;
    let audio_path = root.join("audio.wav");
    fs::write(&audio_path, b"bounded fixture")?;
    let limits = ExportLimits::default();
    let mut value = VideoExportRequest::fixture(&root);
    value.video_bitrate_bps = 1;
    assert!(value.validate(&limits).is_err());
    value.video_bitrate_bps = 500_000;
    value.frame_count = limits.max_frame_count + 1;
    assert!(value.validate(&limits).is_err());
    value.frame_count = 2;
    value.audio = Some(AudioMuxSpec {
        source_path: audio_path,
        stream_index: 128,
        encoder: AudioEncoder::Opus,
        bitrate_bps: 15_999,
        sample_rate_hz: 7_999,
        channels: 0,
    });
    assert!(value.validate(&limits).is_err());
    let existing = root.join("existing.mp4");
    fs::write(&existing, b"do not replace")?;
    value.output_path = existing.clone();
    assert!(matches!(
        value.validate(&limits),
        Err(ExportError::OutputExists(path)) if path == existing
    ));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn command_is_typed_and_keeps_paths_as_single_arguments() -> Result<(), Box<dyn std::error::Error>>
{
    let root = VideoExportRequest::test_root("argv");
    fs::create_dir_all(&root)?;
    let mut value = VideoExportRequest::fixture(&root);
    value.output_path = root.join("clip;$(touch injected).mp4");
    let validated = value.validate(&ExportLimits::default())?;
    let destination = root.join("temporary;still-one-argument.mp4");
    let command = FfmpegExportBackend::default().build_command(&value, &validated, &destination);
    assert_eq!(command.executable(), Path::new("ffmpeg"));
    assert_eq!(
        command.arguments().last(),
        Some(&destination.into_os_string())
    );
    assert!(command.arguments().contains(&"pipe:0".into()));
    assert!(command.arguments().contains(&"libx264".into()));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn h265_is_an_explicit_mp4_path_with_compatible_tag() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("h265-argv");
    fs::create_dir_all(&root)?;
    let mut value = VideoExportRequest::fixture(&root);
    value.encoder = VideoEncoder::H265Software;
    value.input_format = PixelFormat::P010Le;
    let validated = value.validate(&ExportLimits::default())?;
    let destination = root.join("temporary.mp4");
    let command = FfmpegExportBackend::default().build_command(&value, &validated, &destination);
    assert!(command.arguments().contains(&"libx265".into()));
    assert!(command.arguments().contains(&"yuv420p10le".into()));
    assert!(command.arguments().contains(&"hvc1".into()));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn rejects_wrong_frame_sizes_and_short_sources() -> Result<(), Box<dyn std::error::Error>> {
    let cancellation = CancellationToken::default();
    assert_eq!(
        ExportFrameReceiver::write_frames(
            Vec::new(),
            ExportFrameReceiver::fixture(vec![Ok(vec![0; 3])])?,
            4,
            1,
            &cancellation
        ),
        Err(ExportError::InvalidFrameSize {
            index: 0,
            expected: 4,
            actual: 3
        })
    );
    assert_eq!(
        ExportFrameReceiver::write_frames(
            Vec::new(),
            ExportFrameReceiver::fixture(vec![Ok(vec![0; 4])])?,
            4,
            2,
            &cancellation
        ),
        Err(ExportError::FrameCount {
            expected: 2,
            actual: 1
        })
    );
    Ok(())
}

#[test]
fn frame_channel_enforces_finish_extra_frames_and_capacity()
-> Result<(), Box<dyn std::error::Error>> {
    let cancellation = CancellationToken::default();
    assert!(ExportLimits::default().frame_channel(0).is_err());
    assert!(ExportLimits::default().frame_channel(65).is_err());

    assert_eq!(
        ExportFrameReceiver::write_frames(
            Vec::new(),
            ExportFrameReceiver::fixture(vec![Ok(vec![0; 4]), Ok(vec![1; 4])])?,
            4,
            1,
            &cancellation,
        ),
        Err(ExportError::ExtraFrame { expected: 1 })
    );

    let (sender, receiver) = ExportLimits::default().frame_channel(1)?;
    sender.send_frame(Ok(vec![0; 4]))?;
    drop(sender);
    assert_eq!(
        ExportFrameReceiver::write_frames(Vec::new(), receiver, 4, 1, &cancellation),
        Err(ExportError::FrameStreamUnfinished { actual: 1 })
    );
    Ok(())
}

#[test]
fn blocked_frame_receive_observes_cancellation_and_joins() -> Result<(), Box<dyn std::error::Error>>
{
    let (sender, receiver) = ExportLimits::default().frame_channel(1)?;
    let cancellation = CancellationToken::default();
    let writer_cancellation = cancellation.clone();
    let (done_sender, done_receiver) = mpsc::channel();
    let writer = thread::spawn(move || {
        let result =
            ExportFrameReceiver::write_frames(Vec::new(), receiver, 4, 1, &writer_cancellation);
        let _ = done_sender.send(result);
    });
    thread::sleep(Duration::from_millis(20));
    cancellation.cancel();
    assert_eq!(
        done_receiver.recv_timeout(Duration::from_secs(1))?,
        Err(ExportError::Cancelled)
    );
    writer.join().map_err(|_| "writer panicked")?;
    assert_eq!(
        sender.send_frame(Ok(vec![0; 4])),
        Err(ExportFrameSendError::ReceiverClosed)
    );
    Ok(())
}

#[test]
fn child_exit_releases_a_writer_waiting_for_frames_before_join()
-> Result<(), Box<dyn std::error::Error>> {
    let backend = FfmpegExportBackend::default();
    let command = FfmpegCommand::new(std::env::current_exe()?, vec!["--list".into()]);
    let (sender, receiver) = ExportLimits::default().frame_channel(1)?;
    let (done_sender, done_receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = backend.run_export(&command, receiver, 4, 1, &CancellationToken::default());
        let _ = done_sender.send(result);
    });
    assert_eq!(
        done_receiver.recv_timeout(Duration::from_secs(2))?,
        Err(ExportError::Cancelled)
    );
    drop(sender);
    worker.join().map_err(|_| "worker panicked")?;
    Ok(())
}

#[test]
fn delayed_finish_prevents_the_child_from_completing_early()
-> Result<(), Box<dyn std::error::Error>> {
    let command = FfmpegCommand::new(
        std::env::current_exe()?,
        vec![
            "--exact".into(),
            "export::tests::helper_reads_one_frame_from_stdin".into(),
            "--ignored".into(),
            "--nocapture".into(),
        ],
    );
    let (sender, receiver) = ExportLimits::default().frame_channel(2)?;
    sender.send_frame(Ok(vec![7; 4]))?;
    let (done_sender, done_receiver) = mpsc::channel();
    let worker = thread::spawn(move || {
        let result = FfmpegExportBackend::default().run_export(
            &command,
            receiver,
            4,
            1,
            &CancellationToken::default(),
        );
        let _ = done_sender.send(result);
    });

    thread::sleep(Duration::from_millis(100));
    assert_eq!(done_receiver.try_recv(), Err(mpsc::TryRecvError::Empty));
    sender.finish()?;
    assert_eq!(done_receiver.recv_timeout(Duration::from_secs(2))?, Ok(()));
    worker.join().map_err(|_| "worker panicked")?;
    Ok(())
}

#[test]
#[ignore = "subprocess helper for delayed-finish protocol test"]
fn helper_reads_one_frame_from_stdin() -> Result<(), Box<dyn std::error::Error>> {
    let mut frame = [0_u8; 4];
    std::io::stdin().read_exact(&mut frame)?;
    assert_eq!(frame, [7; 4]);
    Ok(())
}

#[test]
fn parses_only_known_video_encoders() -> Result<(), Box<dyn std::error::Error>> {
    let availability = EncoderAvailability::parse(
        b" V....D libx264 H.264 encoder\n V....D hevc_nvenc HEVC encoder\n A..... aac AAC\n",
    );
    assert!(availability.supports(VideoEncoder::H264Software));
    assert!(availability.supports(VideoEncoder::H265Nvenc));
    assert!(!availability.supports(VideoEncoder::H264Nvenc));
    assert_eq!(
        availability.preferred_compiled(VideoCodec::H264),
        Some(VideoEncoder::H264Software)
    );
    Ok(())
}

#[test]
fn failure_cleanup_removes_temporary_directory() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("cleanup");
    fs::create_dir_all(&root)?;
    let (temporary, file) = AtomicFile::stage(&root.join("final.mp4"))?;
    drop(file);
    let directory = temporary.temporary.clone();
    fs::write(&temporary.temporary, b"partial")?;
    drop(temporary);
    assert!(!directory.exists());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn atomic_publish_never_clobbers_a_racing_destination() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("publish-race");
    fs::create_dir_all(&root)?;
    let output = root.join("final.mp4");
    let (temporary, file) = AtomicFile::stage(&output)?;
    drop(file);
    let directory = temporary.temporary.clone();
    fs::write(&temporary.temporary, b"encoded result")?;
    fs::write(&output, b"race winner")?;
    assert!(
        matches!(temporary.publish(false), Err(error) if error.kind() == io::ErrorKind::AlreadyExists)
    );
    assert_eq!(fs::read(&output)?, b"race winner");
    assert!(!directory.exists());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn honours_pre_cancelled_export_before_process_launch() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("cancel");
    fs::create_dir_all(&root)?;
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    let result = FfmpegExportBackend::new("not-an-executable").export(
        &VideoExportRequest::fixture(&root),
        ExportFrameReceiver::fixture(Vec::new())?,
        &cancellation,
    );
    assert_eq!(result, Err(ExportError::Cancelled));
    assert!(fs::read_dir(&root)?.next().is_none());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn zero_timeout_terminates_a_spawned_process() -> Result<(), Box<dyn std::error::Error>> {
    let child = Command::new(std::env::current_exe()?)
        .arg("--list")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let mut child = MediaProcess { child };
    assert_eq!(
        child.monitor(Duration::ZERO, &CancellationToken::default(), None),
        Err(crate::FfmpegError::TimedOut { timeout_ms: 0 })
    );
    assert!(child.child.try_wait()?.is_some());
    Ok(())
}

#[test]
#[ignore = "requires FFmpeg with libx264 and FFprobe on PATH"]
fn encodes_and_probes_real_h264_with_audio() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("real");
    fs::create_dir_all(&root)?;
    let audio = root.join("tone.wav");
    let status = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.1",
            "-c:a",
            "pcm_s16le",
            "-y",
        ])
        .arg(&audio)
        .status()?;
    assert!(status.success());

    let mut value = VideoExportRequest::fixture(&root);
    value.frame_count = 3;
    value.audio = Some(AudioMuxSpec {
        source_path: audio,
        stream_index: 0,
        encoder: AudioEncoder::Aac,
        bitrate_bps: 96_000,
        sample_rate_hz: 48_000,
        channels: 2,
    });
    let frames = ExportFrameReceiver::fixture(
        (0..3)
            .map(|index| {
                let mut frame = vec![0_u8; 16 * 16 * 4];
                for pixel in frame.chunks_exact_mut(4) {
                    pixel.copy_from_slice(&[index * 80, 32, 200, 255]);
                }
                Ok(frame)
            })
            .collect(),
    )?;
    let report =
        FfmpegExportBackend::default().export(&value, frames, &CancellationToken::default())?;
    assert!(report.bytes_written > 0);

    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,codec_type,width,height",
            "-of",
            "json",
        ])
        .arg(&value.output_path)
        .output()?;
    assert!(output.status.success());
    let json = String::from_utf8_lossy(&output.stdout);
    assert!(json.contains("h264"));
    assert!(json.contains("aac"));
    assert!(json.contains("16"));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
#[ignore = "requires FFmpeg with libx265 and FFprobe on PATH"]
fn encodes_and_probes_real_optional_h265() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("real-h265");
    fs::create_dir_all(&root)?;
    let mut value = VideoExportRequest::fixture(&root);
    value.encoder = VideoEncoder::H265Software;
    value.input_format = PixelFormat::P010Le;
    value.frame_count = 2;
    let frame_bytes = PixelFormat::P010Le
        .frame_bytes(16, 16)
        .ok_or("invalid frame geometry")? as usize;
    let frames =
        ExportFrameReceiver::fixture((0..2).map(move |_| Ok(vec![0_u8; frame_bytes])).collect())?;
    let report =
        FfmpegExportBackend::default().export(&value, frames, &CancellationToken::default())?;
    assert!(report.bytes_written > 0);

    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,codec_tag_string,pix_fmt",
            "-of",
            "json",
        ])
        .arg(&value.output_path)
        .output()?;
    assert!(output.status.success());
    let json = String::from_utf8_lossy(&output.stdout);
    assert!(json.contains("hevc"));
    assert!(json.contains("hvc1"));
    assert!(json.contains("yuv420p10le"));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
#[ignore = "requires FFmpeg with a working NVIDIA NVENC device and FFprobe on PATH"]
fn encodes_and_probes_real_h264_nvenc() -> Result<(), Box<dyn std::error::Error>> {
    let root = VideoExportRequest::test_root("real-nvenc");
    fs::create_dir_all(&root)?;
    let mut value = VideoExportRequest::fixture(&root);
    value.encoder = VideoEncoder::H264Nvenc;
    value.width = 256;
    value.height = 144;
    value.frame_count = 2;
    let frames = ExportFrameReceiver::fixture(
        (0..2)
            .map(|index| {
                let mut frame = vec![0_u8; 256 * 144 * 4];
                for pixel in frame.chunks_exact_mut(4) {
                    pixel.copy_from_slice(&[20, index * 100, 220, 255]);
                }
                Ok(frame)
            })
            .collect(),
    )?;
    let report =
        FfmpegExportBackend::default().export(&value, frames, &CancellationToken::default())?;
    assert_eq!(report.encoder, VideoEncoder::H264Nvenc);
    assert!(report.bytes_written > 0);

    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name,width,height",
            "-of",
            "json",
        ])
        .arg(&value.output_path)
        .output()?;
    assert!(output.status.success());
    let json = String::from_utf8_lossy(&output.stdout);
    assert!(json.contains("h264"));
    assert!(json.contains("256"));
    assert!(json.contains("144"));
    fs::remove_dir_all(root)?;
    Ok(())
}

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
      "time_base": "1/48000", "sample_rate": "48000", "channels": 2
    }
  ],
  "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "12.345000"}
}"#;

#[test]
fn parses_ffprobe_streams_color_and_timebases() -> Result<(), Box<dyn std::error::Error>> {
    let metadata = ProbeLimits::default().parse_ffprobe_json(SAMPLE)?;
    assert_eq!(metadata.format, "mov");
    assert_eq!(metadata.duration_ticks, 12_345_000_000);
    assert_eq!(metadata.streams.len(), 2);
    let video = &metadata.streams[0];
    assert_eq!(video.timebase, Timebase::new(1, 90_000)?);
    assert_eq!(video.frame_rate, Some(Timebase::new(1001, 30_000)?));
    assert_eq!(video.color.primaries, ColorPrimaries::Bt2020);
    assert_eq!(video.color.transfer, TransferFunction::Pq);
    assert_eq!(video.color.matrix, MatrixCoefficients::Bt2020NonConstant);
    assert!(video.color.full_range);
    assert!(video.default);
    let audio = &metadata.streams[1];
    assert_eq!(audio.sample_rate, 48_000);
    assert_eq!(audio.channels, 2);
    Ok(())
}

#[test]
fn rejects_malformed_and_unbounded_probe_data() -> Result<(), Box<dyn std::error::Error>> {
    assert!(matches!(
        ProbeLimits::default()
            .parse_ffprobe_json(br#"{"format":{"format_name":"mp4","duration":"NaN"}}"#),
        Err(FfprobeError::InvalidMetadata(_))
    ));
    assert!(matches!(
        ProbeLimits::default().parse_ffprobe_json(&vec![b' '; 1024 * 1024 + 1]),
        Err(FfprobeError::OutputTooLarge { .. })
    ));
    Ok(())
}

#[test]
fn bounded_reader_drains_but_does_not_retain_excess_output()
-> Result<(), Box<dyn std::error::Error>> {
    let result = read_bounded(&b"0123456789"[..], 4)?;
    assert_eq!(result.bytes, b"0123");
    assert!(result.overflowed);
    Ok(())
}

#[test]
fn builds_argument_vector_without_shell_interpretation() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-ffprobe-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let media = root.join("clip;$(touch injected).mp4");
    File::create(&media)?;
    let command = FfprobeBackend::default().build_command(&media)?;
    assert_eq!(command.executable(), Path::new("ffprobe"));
    assert_eq!(command.arguments().last(), Some(&media.into_os_string()));
    let decode = FfmpegBackend::default().build_decode_command(
        &root.join("clip;$(touch injected).mp4"),
        7,
        1.25,
    )?;
    assert_eq!(decode.executable(), Path::new("ffmpeg"));
    assert!(decode.arguments().contains(&"0:7".into()));
    assert!(decode.arguments().contains(&"1.250000000".into()));
    let _ = std::fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn honours_pre_cancelled_requests_without_launching() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-cancel-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
    let media = root.join("clip.mp4");
    File::create(&media)?;
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert_eq!(
        FfprobeBackend::new("definitely-not-an-executable").probe(&media, &cancellation),
        Err(FfprobeError::Cancelled)
    );
    let _ = std::fs::remove_dir_all(root);
    Ok(())
}

#[test]
#[ignore = "requires ffmpeg and ffprobe on PATH"]
fn probes_a_real_generated_container() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-real-probe-{}", std::process::id()));
    std::fs::create_dir_all(&root)?;
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
        .status()?;
    assert!(status.success());

    let metadata = FfprobeBackend::default().probe(&media, &CancellationToken::default())?;
    let video = metadata.select_video_stream()?;
    assert_eq!((video.width, video.height), (16, 16));
    let frame = FfmpegBackend::default().decode_rgba_frame(
        &media,
        video,
        0.0,
        &CancellationToken::default(),
    )?;
    assert_eq!(frame.descriptor.format, GpuPixelFormat::Rgba8);
    assert_eq!(frame.bytes.len() as u64, frame.descriptor.allocation_size);
    assert_eq!(frame.descriptor.planes[0].bytes_per_row % 256, 0);
    assert!(frame.bytes.iter().any(|byte| *byte != 0));
    let _ = std::fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn checks_aligned_frame_budget_and_dimensions_before_spawning() {
    let backend = FfmpegBackend::with_limits(
        "missing-executable",
        DecodeLimits {
            max_frame_bytes: 16,
            ..DecodeLimits::default()
        },
    );
    let mut stream = StreamMetadata {
        index: 0,
        kind: StreamKind::Video,
        codec: "rawvideo".into(),
        timebase: Timebase {
            numerator: 1,
            denominator: 1,
        },
        default: true,
        width: 2,
        height: 2,
        frame_rate: None,
        sample_rate: 0,
        channels: 0,
        color: ColorMetadata::default(),
    };
    assert!(matches!(
        backend.decode_rgba_frame(
            Path::new("missing-file"),
            &stream,
            0.0,
            &CancellationToken::default()
        ),
        Err(FfmpegError::OutputTooLarge {
            stream: "stdout",
            limit: 16
        })
    ));
    stream.width = u32::MAX;
    stream.height = u32::MAX;
    assert!(matches!(
        backend.decode_rgba_frame(
            Path::new("missing-file"),
            &stream,
            0.0,
            &CancellationToken::default()
        ),
        Err(FfmpegError::InvalidMetadata(_))
    ));
}

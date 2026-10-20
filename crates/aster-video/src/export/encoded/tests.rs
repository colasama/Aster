use super::*;
use crate::export::{AudioEncoder, ExportFrame, ExportFrameSender};
use std::{process::Command, thread};

impl EncodedVideoExportRequest {
    fn fixture(root: &Path) -> Self {
        Self {
            output_path: root.join("encoded.mp4"),
            frame_rate_numerator: 30_000,
            frame_rate_denominator: 1001,
            frame_count: 6,
            maximum_packet_bytes: 1_048_576,
            audio: None,
        }
    }
}

struct PacketFixture;
impl PacketFixture {
    fn queue(packets: Vec<ExportFrame>, finish: bool) -> Result<ExportFrameReceiver, ExportError> {
        let (sender, receiver) = ExportLimits::default().frame_channel(packets.len() + 1)?;
        for packet in packets {
            sender
                .send_frame(packet)
                .map_err(|e| ExportError::ProcessIo(e.to_string()))?;
        }
        if finish {
            sender
                .finish()
                .map_err(|e| ExportError::ProcessIo(e.to_string()))?;
        }
        Ok(receiver)
    }

    fn run(args: &[&str], output: &Path) -> Result<(), Box<dyn std::error::Error>> {
        let result = Command::new("ffmpeg")
            .args(["-hide_banner", "-v", "error", "-nostdin"])
            .args(args)
            .arg(output)
            .output()?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr).into_owned().into());
        }
        Ok(())
    }
}

#[test]
fn encoded_requests_preserve_timing_and_reject_invalid_admission()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-mux-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root)?;
    let mut request = EncodedVideoExportRequest::fixture(&root);
    let limits = ExportLimits::default();
    assert!((request.validate(&limits)? - 0.2002).abs() < 1e-12);
    let command = request.command(
        Path::new("ffmpeg"),
        &root.join("pending clip 临时.mp4"),
        0.2002,
    );
    let args = command.arguments();
    assert!(
        args.windows(2)
            .any(|a| a == [OsString::from("-c:v"), OsString::from("copy")])
    );
    assert!(args.iter().any(|a| {
        a.to_string_lossy()
            .contains("setts=ts=N*1001:duration=1001:time_base=1/30000")
    }));
    assert_eq!(
        args.last(),
        Some(&root.join("pending clip 临时.mp4").into_os_string())
    );
    request.frame_rate_denominator = 0;
    assert!(request.validate(&limits).is_err());
    request.frame_rate_denominator = 1001;
    request.maximum_packet_bytes = 0;
    assert!(request.validate(&limits).is_err());
    request.maximum_packet_bytes = 1_048_576;
    request.frame_count = limits.max_frame_count + 1;
    assert!(request.validate(&limits).is_err());
    request.frame_count = 6;
    fs::write(&request.output_path, b"existing")?;
    assert!(matches!(
        request.validate(&limits),
        Err(ExportError::OutputExists(_))
    ));
    assert_eq!(fs::read(&request.output_path)?, b"existing");
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn encoded_stream_requires_bounded_packets_and_explicit_completion()
-> Result<(), Box<dyn std::error::Error>> {
    let packet = vec![0, 0, 0, 1, 0x65, 0x88];
    let cancellation = CancellationToken::default();
    for invalid in [vec![], vec![1, 2, 3, 4, 5], vec![0, 0, 0, 1, 0x65, 0, 0]] {
        assert!(
            ExportFrameReceiver::write_frames(
                Vec::new(),
                PacketFixture::queue(vec![Ok(invalid)], true)?,
                FrameEncoding::AnnexB { maximum_bytes: 6 },
                1,
                &cancellation
            )
            .is_err()
        );
    }
    assert!(matches!(
        ExportFrameReceiver::write_frames(
            Vec::new(),
            PacketFixture::queue(vec![Ok(packet.clone())], false)?,
            FrameEncoding::AnnexB { maximum_bytes: 6 },
            1,
            &cancellation
        ),
        Err(ExportError::FrameStreamUnfinished { actual: 1 })
    ));
    assert!(matches!(
        ExportFrameReceiver::write_frames(
            Vec::new(),
            PacketFixture::queue(vec![Ok(packet.clone()), Ok(packet.clone())], true)?,
            FrameEncoding::AnnexB { maximum_bytes: 6 },
            1,
            &cancellation
        ),
        Err(ExportError::ExtraFrame { expected: 1 })
    ));
    let mut output = Vec::new();
    ExportFrameReceiver::write_frames(
        &mut output,
        PacketFixture::queue(vec![Ok(packet.clone())], true)?,
        FrameEncoding::AnnexB { maximum_bytes: 6 },
        1,
        &cancellation,
    )?;
    assert_eq!(output, packet);
    Ok(())
}

#[derive(serde::Deserialize)]
struct Probe {
    streams: Vec<ProbeStream>,
}
#[derive(serde::Deserialize)]
struct ProbeStream {
    codec_name: String,
    codec_type: String,
    #[serde(default)]
    nb_read_frames: Option<String>,
    #[serde(default)]
    r_frame_rate: Option<String>,
    #[serde(default)]
    duration: Option<String>,
    #[serde(default)]
    color_space: Option<String>,
    #[serde(default)]
    color_range: Option<String>,
}

#[test]
#[ignore = "requires FFmpeg with libx264 and FFprobe on PATH"]
fn real_h264_mux_preserves_frames_audio_and_cleans_interrupted_jobs()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-mux-real-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&root)?;
    let source = root.join("source.h264");
    PacketFixture::run(
        &[
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=32x32:rate=30000/1001",
            "-frames:v",
            "6",
            "-c:v",
            "libx264",
            "-x264-params",
            "aud=1:repeat-headers=1:bframes=0",
            "-g",
            "1",
            "-f",
            "h264",
        ],
        &source,
    )?;
    let audio = root.join("tone.wav");
    PacketFixture::run(
        &[
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.3",
            "-c:a",
            "pcm_s16le",
        ],
        &audio,
    )?;
    let bytes = fs::read(&source)?;
    let starts = bytes
        .windows(5)
        .enumerate()
        .filter(|(_, w)| w[0..4] == [0, 0, 0, 1] && w[4] & 31 == 9)
        .map(|(i, _)| i)
        .collect::<Vec<_>>();
    assert_eq!(starts.len(), 6);
    assert_eq!(starts[0], 0);
    let packets = starts
        .iter()
        .enumerate()
        .map(|(i, start)| bytes[*start..starts.get(i + 1).copied().unwrap_or(bytes.len())].to_vec())
        .collect::<Vec<_>>();
    let mut request = EncodedVideoExportRequest::fixture(&root);
    request.audio = Some(AudioMuxSpec {
        source_path: audio,
        stream_index: 0,
        encoder: AudioEncoder::Aac,
        bitrate_bps: 192_000,
        sample_rate_hz: 48_000,
        channels: 2,
    });
    let report = FfmpegExportBackend::default().mux_h264(
        &request,
        PacketFixture::queue(packets.iter().cloned().map(Ok).collect(), true)?,
        &CancellationToken::default(),
    )?;
    assert!(report.bytes_written > 0);
    let output=Command::new("ffprobe").args(["-v","error","-count_frames","-show_entries","stream=codec_name,codec_type,nb_read_frames,r_frame_rate,duration,color_space,color_range","-of","json"]).arg(&request.output_path).output()?;
    assert!(output.status.success());
    let probe: Probe = serde_json::from_slice(&output.stdout)?;
    let video = probe
        .streams
        .iter()
        .find(|s| s.codec_type == "video")
        .ok_or("video absent")?;
    assert_eq!(video.codec_name, "h264");
    assert_eq!(video.nb_read_frames.as_deref(), Some("6"));
    assert_eq!(video.r_frame_rate.as_deref(), Some("30000/1001"));
    assert_eq!(video.color_space.as_deref(), Some("bt709"));
    assert_eq!(video.color_range.as_deref(), Some("tv"));
    assert!(
        (video
            .duration
            .as_deref()
            .ok_or("duration absent")?
            .parse::<f64>()?
            - 0.2002)
            .abs()
            < 0.0001
    );
    let audio = probe
        .streams
        .iter()
        .find(|s| s.codec_type == "audio")
        .ok_or("audio absent")?;
    assert_eq!(audio.codec_name, "aac");
    assert!(
        (audio
            .duration
            .as_deref()
            .ok_or("audio duration absent")?
            .parse::<f64>()?
            - 0.2002)
            .abs()
            < 0.05
    );
    let original = root.join("source.yuv");
    let copied = root.join("copy.yuv");
    PacketFixture::run(
        &[
            "-i",
            source.to_str().ok_or("source path")?,
            "-pix_fmt",
            "yuv420p",
            "-f",
            "rawvideo",
        ],
        &original,
    )?;
    PacketFixture::run(
        &[
            "-i",
            request.output_path.to_str().ok_or("output path")?,
            "-pix_fmt",
            "yuv420p",
            "-f",
            "rawvideo",
        ],
        &copied,
    )?;
    assert_eq!(fs::read(original)?, fs::read(copied)?);
    request.output_path = root.join("rejected.mp4");
    let before = fs::read_dir(&root)?.count();
    let mut extra = packets.clone();
    extra.push(packets[0].clone());
    for (values, finish) in [
        (extra, true),
        (packets.clone(), false),
        (packets[..3].to_vec(), true),
    ] {
        assert!(
            FfmpegExportBackend::default()
                .mux_h264(
                    &request,
                    PacketFixture::queue(values.into_iter().map(Ok).collect(), finish)?,
                    &CancellationToken::default()
                )
                .is_err()
        );
        assert!(!request.output_path.exists());
        assert_eq!(fs::read_dir(&root)?.count(), before);
    }
    let (sender, receiver): (ExportFrameSender, ExportFrameReceiver) =
        ExportLimits::default().frame_channel(1)?;
    let cancellation = CancellationToken::default();
    let stop = cancellation.clone();
    let pending = request.clone();
    let worker =
        thread::spawn(move || FfmpegExportBackend::default().mux_h264(&pending, receiver, &stop));
    thread::sleep(Duration::from_millis(100));
    cancellation.cancel();
    assert!(matches!(
        worker.join().map_err(|_| "mux panicked")?,
        Err(ExportError::Cancelled)
    ));
    drop(sender);
    assert!(!request.output_path.exists());
    assert_eq!(fs::read_dir(&root)?.count(), before);
    fs::remove_dir_all(root)?;
    Ok(())
}

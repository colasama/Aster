use std::{io::Write, process::Stdio};

use aster_storage::AtomicFile;
use serde::{Deserialize, Serialize};

use crate::{
    CancellationToken, ContainerMetadata, FfmpegBackend, FfmpegCommand, FfmpegError,
    FfprobeBackend, StreamMetadata,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PresentationFrame {
    pub best_effort_timestamp: i64,
    #[serde(default, alias = "pkt_duration")]
    pub duration: i64,
}

#[derive(Deserialize)]
struct FrameIndex {
    frames: Vec<PresentationFrame>,
    streams: Vec<SnapshotStream>,
}

#[derive(Deserialize)]
struct SnapshotStream {
    pix_fmt: String,
    #[serde(default)]
    chroma_location: Option<String>,
    #[serde(default)]
    color_primaries: Option<String>,
    #[serde(default)]
    color_transfer: Option<String>,
    #[serde(default)]
    color_space: Option<String>,
    #[serde(default)]
    color_range: Option<String>,
}

impl SnapshotStream {
    fn untagged_sdr(&self) -> bool {
        // Preserve raw tags: unsupported explicit values also normalize to Unspecified.
        [
            &self.color_primaries,
            &self.color_transfer,
            &self.color_space,
        ]
        .iter()
        .all(|tag| matches!(tag.as_deref(), None | Some("unknown" | "unspecified")))
            && matches!(self.color_range.as_deref(), None | Some("unknown" | "tv"))
    }
}

/// Owns a private seekable snapshot until all probe/decode subprocesses have stopped.
pub struct VideoSnapshot {
    file: AtomicFile,
    pub stream: StreamMetadata,
    pub frames: Vec<PresentationFrame>,
    pub pixel_format: String,
    pub chroma_location: Option<String>,
    pub untagged_sdr: bool,
}

impl FfprobeBackend {
    pub fn video_snapshot(
        &self,
        bytes: &[u8],
        max_pixels: u64,
        cancellation: &CancellationToken,
    ) -> Result<VideoSnapshot, FfmpegError> {
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        if bytes.is_empty() || bytes.len() as u64 > self.limits.max_media_bytes {
            return Err(FfmpegError::MediaTooLarge {
                limit: self.limits.max_media_bytes,
            });
        }
        let (file, mut writer) =
            AtomicFile::stage(&std::env::temp_dir().join("aster-video-snapshot.mp4"))
                .map_err(|e| FfmpegError::ProcessIo(e.to_string()))?;
        writer
            .write_all(bytes)
            .map_err(|e| FfmpegError::ProcessIo(e.to_string()))?;
        drop(writer);
        let mut args = [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            "mov",
            "-enable_drefs",
            "0",
            "-select_streams",
            "v:0",
            "-show_format",
            "-show_streams",
            "-show_frames",
            "-show_entries",
            "frame=best_effort_timestamp,duration:stream:format",
            "-print_format",
            "json",
        ]
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();
        args.extend([
            "-max_pixels".into(),
            max_pixels.to_string().into(),
            "-i".into(),
            file.temporary.as_os_str().to_owned(),
        ]);
        let command = FfmpegCommand::new(self.executable.clone(), args);
        let output = command
            .spawn(Stdio::null(), Stdio::piped())
            .map_err(|e| FfmpegError::ProcessIo(e.to_string()))?
            .capture(
                self.limits.timeout,
                self.limits.max_stdout_bytes,
                self.limits.max_stderr_bytes,
                cancellation,
            )?;
        if !output.status.success() {
            return Err(FfmpegError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        if !output.stderr.is_empty() {
            return Err(FfmpegError::InvalidMetadata(format!(
                "video probe reported decode errors: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let metadata: ContainerMetadata = self.limits.parse_ffprobe_json(&output.stdout)?;
        let stream = metadata.select_video_stream()?.clone();
        let index: FrameIndex = serde_json::from_slice(&output.stdout)
            .map_err(|e| FfmpegError::InvalidMetadata(e.to_string()))?;
        if index.frames.is_empty()
            || index.streams.len() != 1
            || index.frames.iter().any(|f| f.duration <= 0)
            || index
                .frames
                .windows(2)
                .any(|p| p[0].best_effort_timestamp >= p[1].best_effort_timestamp)
        {
            return Err(FfmpegError::InvalidMetadata(
                "ordered presentation frames with positive duration required".into(),
            ));
        }
        let raw =
            index.streams.into_iter().next().ok_or_else(|| {
                FfmpegError::InvalidMetadata("video stream metadata absent".into())
            })?;
        let untagged_sdr = raw.untagged_sdr();
        Ok(VideoSnapshot {
            file,
            stream,
            frames: index.frames,
            pixel_format: raw.pix_fmt,
            chroma_location: raw.chroma_location,
            untagged_sdr,
        })
    }
}

impl FfmpegBackend {
    /// Select by presentation-order index; decimal seeks cannot choose a neighboring frame.
    pub fn decode_snapshot_frame(
        &self,
        snapshot: &VideoSnapshot,
        frame_index: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, FfmpegError> {
        self.decode_snapshot_frames(snapshot, frame_index, 1, cancellation)
    }

    /// Decode a bounded presentation-order window in one process, without timestamp seeking.
    pub fn decode_snapshot_frames(
        &self,
        snapshot: &VideoSnapshot,
        frame_index: usize,
        frame_count: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, FfmpegError> {
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        let stream = &snapshot.stream;
        let size = u64::from(stream.width) * u64::from(stream.height) * 4;
        let end = frame_index.checked_add(frame_count);
        let total = size.checked_mul(frame_count as u64);
        if frame_count == 0
            || end.is_none_or(|end| end > snapshot.frames.len())
            || size == 0
            || total.is_none_or(|bytes| bytes > self.limits().max_frame_bytes as u64)
        {
            return Err(FfmpegError::InvalidMetadata(
                "video frame index or extent exceeds limits".into(),
            ));
        }
        // Match the browser's centered chroma reconstruction before its straight RGB upload.
        let color_conversion = if snapshot.untagged_sdr
            && stream.width <= 1024
            && stream.height <= 576
        {
            // Chromium first clips its decoded RGB, then converts SMPTE 170M primaries
            // using the legacy sRGB transfer. Preserve precision across the YUV bridge.
            "format=rgb24,scale=out_color_matrix=bt601:out_range=tv,format=yuv444p10,colorspace=iall=smpte170m:itrc=iec61966-2-1:all=bt709:trc=iec61966-2-1:format=yuv444p10,"
        } else {
            ""
        };
        let filter = format!(
            "select=between(n\\,{frame_index}\\,{}),scale=in_h_chr_pos=128:in_v_chr_pos=128:flags=bilinear+accurate_rnd+full_chroma_int,format=yuv444p,{color_conversion}format=rgba",
            frame_index + frame_count - 1
        );
        let mut args = [
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-f",
            "mov",
            "-enable_drefs",
            "0",
        ]
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();
        args.extend([
            "-threads".into(),
            self.limits().worker_threads.to_string().into(),
            "-filter_threads".into(),
            self.limits().worker_threads.to_string().into(),
            "-i".into(),
            snapshot.file.temporary.as_os_str().to_owned(),
            "-threads".into(),
            self.limits().worker_threads.to_string().into(),
        ]);
        args.extend([
            "-map".into(),
            format!("0:{}", stream.index).into(),
            "-vf".into(),
            filter.into(),
            "-frames:v".into(),
            frame_count.to_string().into(),
        ]);
        args.extend(
            [
                "-fps_mode",
                "passthrough",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ]
            .into_iter()
            .map(Into::into),
        );
        let command = FfmpegCommand::new(self.executable().to_owned(), args);
        let total =
            total.ok_or_else(|| FfmpegError::InvalidMetadata("video window overflow".into()))?;
        let output = self.execute(&command, total as usize, cancellation)?;
        if !output.status.success() {
            return Err(FfmpegError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        if output.stdout.len() as u64 != total {
            return Err(FfmpegError::InvalidMetadata(
                "decoded video extent differs".into(),
            ));
        }
        if !output.stderr.is_empty() {
            return Err(FfmpegError::InvalidMetadata(format!(
                "video decode reported errors: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        Ok(output.stdout)
    }
}

#[cfg(test)]
mod tests {
    use super::SnapshotStream;

    #[test]
    fn untagged_color_does_not_admit_unrecognized_explicit_tags() -> Result<(), serde_json::Error> {
        for input in [
            r#"{"pix_fmt":"yuv420p"}"#,
            r#"{"pix_fmt":"yuv420p","color_primaries":"unknown","color_transfer":"unknown","color_space":"unknown","color_range":"tv"}"#,
        ] {
            assert!(serde_json::from_str::<SnapshotStream>(input)?.untagged_sdr());
        }
        for input in [
            r#"{"pix_fmt":"yuv420p","color_primaries":"smpte432"}"#,
            r#"{"pix_fmt":"yuv420p","color_transfer":"smpte2084"}"#,
            r#"{"pix_fmt":"yuv420p","color_space":"bt2020nc"}"#,
            r#"{"pix_fmt":"yuv420p","color_space":"smpte170m"}"#,
            r#"{"pix_fmt":"yuv420p","color_range":"pc"}"#,
            r#"{"pix_fmt":"yuv420p","color_range":"invalid"}"#,
        ] {
            assert!(!serde_json::from_str::<SnapshotStream>(input)?.untagged_sdr());
        }
        Ok(())
    }
}

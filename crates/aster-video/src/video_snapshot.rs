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
}

/// Owns a private seekable snapshot until all probe/decode subprocesses have stopped.
pub struct VideoSnapshot {
    file: AtomicFile,
    pub stream: StreamMetadata,
    pub frames: Vec<PresentationFrame>,
    pub pixel_format: String,
    pub chroma_location: Option<String>,
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
        Ok(VideoSnapshot {
            file,
            stream,
            frames: index.frames,
            pixel_format: raw.pix_fmt,
            chroma_location: raw.chroma_location,
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
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        let stream = &snapshot.stream;
        let size = u64::from(stream.width) * u64::from(stream.height) * 4;
        if frame_index >= snapshot.frames.len()
            || size == 0
            || size > self.limits().max_frame_bytes as u64
        {
            return Err(FfmpegError::InvalidMetadata(
                "video frame index or extent exceeds limits".into(),
            ));
        }
        // Match the browser's centered chroma reconstruction before its straight RGB upload.
        let filter = format!(
            "select=eq(n\\,{frame_index}),scale=in_h_chr_pos=128:in_v_chr_pos=128:flags=bilinear+accurate_rnd+full_chroma_int,format=yuv444p,format=rgba"
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
            "-i",
        ]
        .into_iter()
        .map(Into::into)
        .collect::<Vec<_>>();
        args.push(snapshot.file.temporary.as_os_str().to_owned());
        args.extend([
            "-map".into(),
            format!("0:{}", stream.index).into(),
            "-vf".into(),
            filter.into(),
        ]);
        args.extend(
            [
                "-fps_mode",
                "passthrough",
                "-frames:v",
                "1",
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
        let output = self.execute(&command, size as usize, cancellation)?;
        if !output.status.success() {
            return Err(FfmpegError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        if output.stdout.len() as u64 != size {
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

use std::{io::Write, process::Stdio, sync::Arc, thread};

use crate::{CancellationToken, FfmpegBackend, FfmpegCommand, FfmpegError};

#[derive(Clone, Copy, Debug)]
pub enum StillEncoding {
    Png,
    Jpeg,
}

impl StillEncoding {
    pub fn detect(bytes: &[u8]) -> Result<Self, FfmpegError> {
        if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            Ok(Self::Png)
        } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
            Ok(Self::Jpeg)
        } else {
            Err(FfmpegError::InvalidMetadata(
                "unsupported native still encoding".into(),
            ))
        }
    }

    pub fn dimensions(self, bytes: &[u8]) -> Result<(u32, u32), FfmpegError> {
        if matches!(self, Self::Png) {
            if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
                let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
                let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
                return Ok((width, height));
            }
        } else {
            let mut offset = 2;
            while offset < bytes.len() {
                if bytes[offset] != 0xff {
                    break;
                }
                while bytes.get(offset) == Some(&0xff) {
                    offset += 1;
                }
                let Some(&marker) = bytes.get(offset) else {
                    break;
                };
                offset += 1;
                if matches!(marker, 0x01 | 0xd0..=0xd7) {
                    continue;
                }
                if matches!(marker, 0xda | 0xd9) || offset + 2 > bytes.len() {
                    break;
                }
                let length = usize::from(u16::from_be_bytes([bytes[offset], bytes[offset + 1]]));
                if length < 2 || length > bytes.len() - offset {
                    break;
                }
                if matches!(marker, 0xc0..=0xc3 | 0xc5..=0xc7 | 0xc9..=0xcb | 0xcd..=0xcf)
                    && length >= 8
                {
                    let height =
                        u32::from(u16::from_be_bytes([bytes[offset + 3], bytes[offset + 4]]));
                    let width =
                        u32::from(u16::from_be_bytes([bytes[offset + 5], bytes[offset + 6]]));
                    return Ok((width, height));
                }
                offset += length;
            }
        }
        Err(FfmpegError::InvalidMetadata(
            "still image dimensions are absent or malformed".into(),
        ))
    }
}

impl FfmpegBackend {
    /// Decode an immutable authorized snapshot. The child receives no source filesystem path.
    pub fn decode_still_rgba(
        &self,
        encoded: Arc<[u8]>,
        size: (u32, u32),
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, FfmpegError> {
        let (width, height) = size;
        let limits = self.limits();
        let expected = (u64::from(width) * u64::from(height))
            .checked_mul(4)
            .ok_or_else(|| FfmpegError::InvalidMetadata("still extent overflow".into()))?;
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        if width == 0
            || height == 0
            || width > limits.metadata.max_dimension
            || height > limits.metadata.max_dimension
            || expected > limits.max_frame_bytes as u64
            || encoded.len() as u64 > limits.max_media_bytes
        {
            return Err(FfmpegError::InvalidMetadata(
                "still decode exceeds extent or byte limits".into(),
            ));
        }
        let encoding = StillEncoding::detect(&encoded)?;
        if encoding.dimensions(&encoded)? != size {
            return Err(FfmpegError::InvalidMetadata(
                "encoded still dimensions differ from supplied frame".into(),
            ));
        }
        let codec = match encoding {
            StillEncoding::Png => "png",
            StillEncoding::Jpeg => "mjpeg",
        };
        let command = FfmpegCommand::new(
            self.executable().to_owned(),
            [
                "-v",
                "error",
                "-protocol_whitelist",
                "pipe",
                "-f",
                "image2pipe",
                "-c:v",
                codec,
                "-i",
                "pipe:0",
                "-map",
                "0:v:0",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "pipe:1",
            ]
            .into_iter()
            .map(Into::into)
            .collect(),
        );
        let mut child = command
            .spawn(Stdio::piped(), Stdio::piped())
            .map_err(|e| FfmpegError::ProcessIo(e.to_string()))?;
        let mut stdin = child
            .child
            .stdin
            .take()
            .ok_or_else(|| FfmpegError::ProcessIo("still input pipe absent".into()))?;
        let writer = thread::spawn(move || stdin.write_all(&encoded));
        let output = child.capture(
            limits.timeout,
            expected as usize,
            limits.max_stderr_bytes,
            cancellation,
        );
        let written = writer
            .join()
            .map_err(|_| FfmpegError::ProcessIo("still input writer panicked".into()))?;
        let output = output?;
        if !output.status.success() {
            return Err(FfmpegError::ProcessFailed {
                code: output.status.code(),
                stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
            });
        }
        written.map_err(|e| FfmpegError::ProcessIo(e.to_string()))?;
        if output.stdout.len() as u64 != expected {
            return Err(FfmpegError::InvalidMetadata(
                "decoded still extent differs from supplied frame".into(),
            ));
        }
        Ok(output.stdout)
    }
}

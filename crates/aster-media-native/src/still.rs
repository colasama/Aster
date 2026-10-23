use std::{path::PathBuf, sync::Arc, time::Duration};

use aster_render_ir::{
    MediaKind, MediaSample, MediaTextureFormat, ResourceDescriptor, ResourceHash, ResourceRegistry,
};
use aster_video::{CancellationToken, DecodeLimits, FfmpegBackend};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    MediaError, MediaSnapshotAuthorization, SnapshotGrantLimits, StillAuthorization,
    authorization::MediaGrants,
};

#[derive(Clone, Debug, clap::Args)]
pub struct StillLimits {
    #[arg(long, default_value_t = 67_108_864)]
    pub still_max_source_bytes: u64,
    #[arg(long, default_value_t = 67_108_864)]
    pub still_max_pixel_bytes: u64,
    #[arg(long, default_value_t = 16384)]
    pub still_max_dimension: u32,
    #[arg(long, default_value_t = 30_000)]
    pub still_timeout_ms: u64,
    #[arg(long, default_value_t = 1_048_576)]
    pub still_max_header_bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeImageReceipt {
    pub frame: ResourceHash,
    pub source: ResourceHash,
    pub source_sha256: String,
    pub rgba_sha256: String,
    pub width: u32,
    pub height: u32,
    pub backend: &'static str,
    pub format: MediaTextureFormat,
}

#[derive(Clone)]
pub struct DecodedStill {
    pub bytes: Vec<u8>,
    pub receipt: NativeImageReceipt,
}

pub struct NativeStillDecoder {
    pub(crate) authorizations: MediaGrants,
    backend: FfmpegBackend,
    limits: StillLimits,
}

impl NativeStillDecoder {
    pub fn new(
        executable: PathBuf,
        authorizations: Vec<StillAuthorization>,
        limits: StillLimits,
    ) -> Result<Self, MediaError> {
        Self::with_snapshots(
            executable,
            authorizations,
            Vec::new(),
            SnapshotGrantLimits::default(),
            limits,
        )
    }

    pub fn with_snapshots(
        executable: PathBuf,
        authorizations: Vec<StillAuthorization>,
        snapshots: Vec<MediaSnapshotAuthorization>,
        snapshot_limits: SnapshotGrantLimits,
        limits: StillLimits,
    ) -> Result<Self, MediaError> {
        if limits.still_max_source_bytes == 0
            || limits.still_max_source_bytes == u64::MAX
            || limits.still_max_pixel_bytes == 0
            || limits.still_max_dimension == 0
            || limits.still_timeout_ms == 0
            || limits.still_max_header_bytes < 8
        {
            return Err(MediaError::Limit(
                "positive bounded decode limits required".into(),
            ));
        }
        let grants = MediaGrants::with_snapshots(authorizations, snapshots, snapshot_limits)?;
        let decode_limits = DecodeLimits {
            max_media_bytes: limits.still_max_source_bytes,
            max_frame_bytes: usize::try_from(limits.still_max_pixel_bytes)
                .map_err(|_| MediaError::Limit("decoded byte limit overflow".into()))?,
            timeout: Duration::from_millis(limits.still_timeout_ms),
            metadata: aster_video::MetadataLimits {
                max_dimension: limits.still_max_dimension,
                ..Default::default()
            },
            ..Default::default()
        };
        Ok(Self {
            authorizations: grants,
            backend: FfmpegBackend::with_limits(executable, decode_limits),
            limits,
        })
    }

    pub fn decode(
        &self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<DecodedStill, MediaError> {
        let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)? else {
            return Err(MediaError::Unsupported(
                "still frame descriptor required".into(),
            ));
        };
        let ResourceDescriptor::MediaSource(source) = registry.descriptor(&frame.source)? else {
            return Err(MediaError::Unsupported(
                "still source descriptor required".into(),
            ));
        };
        let (member, identity) = match (&frame.sample, source.media_kind) {
            (MediaSample::Image, MediaKind::Image) => (None, &source.content_identity),
            (
                MediaSample::Sequence {
                    frame,
                    file_identity,
                },
                MediaKind::Sequence,
            ) => (Some(*frame), file_identity),
            _ => return Err(MediaError::Unsupported("non-still sample".into())),
        };
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if frame.width > self.limits.still_max_dimension
            || frame.height > self.limits.still_max_dimension
            || u64::from(frame.width)
                * u64::from(frame.height)
                * u64::from(frame.format.bytes_per_pixel())
                > self.limits.still_max_pixel_bytes
        {
            return Err(MediaError::Limit(
                "decoded still exceeds extent or byte budget".into(),
            ));
        }
        let snapshot = self.authorizations.read(
            &frame.source,
            &source.authorization_scope,
            member,
            identity,
            self.limits.still_max_source_bytes,
            cancellation,
        )?;
        let encoded = snapshot.bytes;
        let digest = snapshot.sha256;
        let (bytes, backend) = match frame.format {
            MediaTextureFormat::Rgba16Float => (
                crate::exr_snapshot::ExrSnapshot::decode(
                    encoded,
                    frame,
                    &self.limits,
                    cancellation,
                )?,
                "rust-exr-snapshot",
            ),
            MediaTextureFormat::Rgba8UnormSrgb => {
                let (mut bytes, backend) = self.decode_rgba(
                    encoded,
                    (frame.width, frame.height),
                    member.is_some(),
                    cancellation,
                )?;
                Self::canvas_alpha_precision(&mut bytes);
                (bytes, backend)
            }
        };
        Ok(DecodedStill {
            receipt: NativeImageReceipt {
                frame: hash.clone(),
                source: frame.source.clone(),
                source_sha256: digest,
                rgba_sha256: format!("{:x}", Sha256::digest(&bytes)),
                width: frame.width,
                height: frame.height,
                backend,
                format: frame.format,
            },
            bytes,
        })
    }

    fn decode_rgba(
        &self,
        encoded: Vec<u8>,
        size: (u32, u32),
        sequence: bool,
        cancellation: &CancellationToken,
    ) -> Result<(Vec<u8>, &'static str), MediaError> {
        #[cfg(windows)]
        if encoded.len() >= 29
            && &encoded[..8] == b"\x89PNG\r\n\x1a\n"
            && &encoded[12..16] == b"IHDR"
            && encoded[24] == 8
            && matches!(encoded[25], 2 | 6)
            && encoded[26..29] == [0, 0, 0]
        {
            // Decode the already authenticated memory snapshot without color management or
            // premultiplication. Other PNG layouts retain the established FFmpeg conversion.
            let started = std::time::Instant::now();
            let bytes = crate::image_windows::WindowsImage::decode(&encoded, size)?;
            if cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            if started.elapsed() > Duration::from_millis(self.limits.still_timeout_ms) {
                return Err(MediaError::Limit("still decode deadline exceeded".into()));
            }
            return Ok((bytes, "windows-wic-png-snapshot"));
        }
        let bytes = self
            .backend
            .decode_still_rgba(Arc::from(encoded), size, cancellation)?;
        Ok((
            bytes,
            if sequence {
                "ffmpeg-sequence-snapshot"
            } else {
                "ffmpeg-still-snapshot"
            },
        ))
    }

    pub(crate) fn canvas_alpha_precision(bytes: &mut [u8]) {
        for pixel in bytes.chunks_exact_mut(4) {
            let alpha = u32::from(pixel[3]);
            // Opaque channels round-trip unchanged; hidden RGB always rounds to zero.
            // Keep the original integer rounding for every partially transparent sample.
            if alpha == 255 {
                continue;
            }
            if alpha == 0 {
                pixel[..3].fill(0);
                continue;
            }
            for channel in &mut pixel[..3] {
                let associated = (u32::from(*channel) * alpha + 127) / 255;
                *channel = (associated * 255 + alpha / 2)
                    .checked_div(alpha)
                    .map_or(0, |value| value as u8);
            }
        }
    }
}

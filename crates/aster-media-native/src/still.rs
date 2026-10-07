use std::{path::PathBuf, sync::Arc, time::Duration};

use aster_render_ir::{
    MediaKind, MediaSample, MediaTextureFormat, ResourceDescriptor, ResourceHash, ResourceRegistry,
};
use aster_video::{CancellationToken, DecodeLimits, FfmpegBackend};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{MediaError, StillAuthorization, authorization::MediaGrants};

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
    authorizations: MediaGrants,
    backend: FfmpegBackend,
    limits: StillLimits,
}

impl NativeStillDecoder {
    pub fn new(
        executable: PathBuf,
        authorizations: Vec<StillAuthorization>,
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
        let grants = MediaGrants::new(authorizations)?;
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
                let mut bytes = self.backend.decode_still_rgba(
                    Arc::from(encoded),
                    (frame.width, frame.height),
                    cancellation,
                )?;
                Self::canvas_alpha_precision(&mut bytes);
                (
                    bytes,
                    if member.is_some() {
                        "ffmpeg-sequence-snapshot"
                    } else {
                        "ffmpeg-still-snapshot"
                    },
                )
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

    pub(crate) fn canvas_alpha_precision(bytes: &mut [u8]) {
        for pixel in bytes.chunks_exact_mut(4) {
            let alpha = u32::from(pixel[3]);
            for channel in &mut pixel[..3] {
                let associated = (u32::from(*channel) * alpha + 127) / 255;
                *channel = (associated * 255 + alpha / 2)
                    .checked_div(alpha)
                    .map_or(0, |value| value as u8);
            }
        }
    }
}

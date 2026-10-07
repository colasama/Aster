use std::{collections::BTreeMap, fs::File, io::Read, path::PathBuf, sync::Arc, time::Duration};

use aster_render_ir::{
    MediaKind, MediaSample, MediaTextureFormat, ResourceDescriptor, ResourceHash, ResourceRegistry,
};
use aster_video::{CancellationToken, DecodeLimits, FfmpegBackend};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::MediaError;

/// A job broker grants paths explicitly; untrusted frame descriptors never grant file access.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StillAuthorization {
    pub source: ResourceHash,
    /// Sequence grants authorize one member, never an inferred neighboring path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_frame: Option<i64>,
    pub scope: String,
    pub path: PathBuf,
    pub sha256: String,
}

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

#[derive(Debug, Serialize)]
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

pub struct DecodedStill {
    pub bytes: Vec<u8>,
    pub receipt: NativeImageReceipt,
}

pub struct NativeStillDecoder {
    authorizations: BTreeMap<(ResourceHash, Option<i64>), StillAuthorization>,
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
        let mut grants = BTreeMap::new();
        for grant in authorizations {
            grant.source.validate()?;
            ResourceHash(grant.sha256.clone()).validate()?;
            if grant.scope.is_empty()
                || !grant.path.is_absolute()
                || grants
                    .insert((grant.source.clone(), grant.sequence_frame), grant)
                    .is_some()
            {
                return Err(MediaError::Authorization(
                    "unique source members, absolute paths and nonempty scopes required".into(),
                ));
            }
        }
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
        let grant = self
            .authorizations
            .get(&(frame.source.clone(), member))
            .filter(|grant| grant.scope == source.authorization_scope)
            .ok_or_else(|| MediaError::Authorization("source or scope is not granted".into()))?;
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
        let file = File::open(&grant.path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > self.limits.still_max_source_bytes {
            return Err(MediaError::Limit("source exceeds file byte budget".into()));
        }
        let mut encoded = Vec::new();
        file.take(self.limits.still_max_source_bytes + 1)
            .read_to_end(&mut encoded)?;
        if encoded.len() as u64 > self.limits.still_max_source_bytes {
            return Err(MediaError::Limit(
                "source changed beyond file byte budget".into(),
            ));
        }
        let digest = format!("{:x}", Sha256::digest(&encoded));
        let (mut left, mut right) = (0x811c9dc5_u32, 0x9e3779b9_u32);
        for byte in &encoded {
            left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        if digest != grant.sha256
            || *identity != format!("fnv64:{left:08x}{right:08x}:{}", encoded.len())
        {
            return Err(MediaError::Identity);
        }
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

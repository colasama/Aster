use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use aster_render_ir::{ResourceDescriptor, ResourceHash, ResourceRegistry, TextureEncoding};
use aster_video::{CancellationToken, DecodeLimits, FfmpegBackend, StillEncoding};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{MediaCacheStatistics, MediaError};

#[derive(Clone, Debug, clap::Args)]
pub struct TextureLimits {
    #[arg(long, default_value_t = 67_108_864)]
    pub texture_max_source_bytes: u64,
    #[arg(long, default_value_t = 67_108_864)]
    pub texture_max_pixel_bytes: u64,
    #[arg(long, default_value_t = 4096)]
    pub texture_max_dimension: u32,
    #[arg(long, default_value_t = 30_000)]
    pub texture_timeout_ms: u64,
    #[arg(long, default_value_t = 67_108_864)]
    pub texture_cache_bytes: u64,
    #[arg(long, default_value_t = 256)]
    pub texture_cache_entries: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeTextureReceipt {
    pub encoded: ResourceHash,
    pub encoding: TextureEncoding,
    pub rgba_sha256: String,
    pub width: u32,
    pub height: u32,
    pub backend: &'static str,
}

#[derive(Clone)]
pub struct DecodedTexture {
    pub bytes: Arc<[u8]>,
    pub receipt: NativeTextureReceipt,
}

/// Inline resources are already authenticated by the registry and never grant file access.
pub struct NativeTextureSession {
    backend: FfmpegBackend,
    limits: TextureLimits,
    entries: BTreeMap<ResourceHash, (u64, DecodedTexture)>,
    clock: u64,
    stats: MediaCacheStatistics,
}

impl NativeTextureSession {
    pub fn new(executable: PathBuf, limits: TextureLimits) -> Result<Self, MediaError> {
        if limits.texture_max_source_bytes == 0
            || limits.texture_max_source_bytes > 67_108_864
            || limits.texture_max_pixel_bytes == 0
            || limits.texture_max_pixel_bytes > 67_108_864
            || limits.texture_max_dimension == 0
            || limits.texture_max_dimension > 4096
            || limits.texture_timeout_ms == 0
        {
            return Err(MediaError::Limit(
                "bounded texture decode limits required".into(),
            ));
        }
        let backend = FfmpegBackend::with_limits(
            executable,
            DecodeLimits {
                max_media_bytes: limits.texture_max_source_bytes,
                max_frame_bytes: usize::try_from(limits.texture_max_pixel_bytes)
                    .map_err(|_| MediaError::Limit("texture byte limit overflow".into()))?,
                timeout: Duration::from_millis(limits.texture_timeout_ms),
                metadata: aster_video::MetadataLimits {
                    max_dimension: limits.texture_max_dimension,
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        Ok(Self {
            backend,
            stats: MediaCacheStatistics {
                budget_bytes: limits.texture_cache_bytes,
                entry_limit: limits.texture_cache_entries,
                ..Default::default()
            },
            limits,
            entries: BTreeMap::new(),
            clock: 0,
        })
    }

    pub fn statistics(&self) -> MediaCacheStatistics {
        self.stats
    }

    pub fn extent(
        &self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
    ) -> Result<(u32, u32), MediaError> {
        let ResourceDescriptor::EncodedTexture(descriptor) = registry.descriptor(hash)? else {
            return Err(MediaError::Unsupported(
                "encoded texture descriptor required".into(),
            ));
        };
        let bytes = registry.resolve(hash)?;
        descriptor.validate(bytes)?;
        if bytes.len() as u64 > self.limits.texture_max_source_bytes {
            return Err(MediaError::Limit(
                "encoded texture exceeds source budget".into(),
            ));
        }
        let (width, height) = StillEncoding::detect(bytes)?.dimensions(bytes)?;
        if width == 0
            || height == 0
            || width > self.limits.texture_max_dimension
            || height > self.limits.texture_max_dimension
            || u64::from(width) * u64::from(height) * 4 > self.limits.texture_max_pixel_bytes
        {
            return Err(MediaError::Limit(
                "decoded texture exceeds extent or byte budget".into(),
            ));
        }
        Ok((width, height))
    }

    pub fn decode(
        &mut self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<DecodedTexture, MediaError> {
        let started = Instant::now();
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        let size = self.extent(hash, registry)?;
        self.clock = self.clock.saturating_add(1);
        if let Some((age, decoded)) = self.entries.get_mut(hash) {
            *age = self.clock;
            self.stats.hits = self.stats.hits.saturating_add(1);
            return Ok(decoded.clone());
        }
        self.stats.misses = self.stats.misses.saturating_add(1);
        let ResourceDescriptor::EncodedTexture(descriptor) = registry.descriptor(hash)? else {
            return Err(MediaError::Unsupported(
                "encoded texture descriptor required".into(),
            ));
        };
        let (mut bytes, backend) = match descriptor.encoding {
            TextureEncoding::Png => (
                self.backend.decode_still_rgba(
                    Arc::from(registry.resolve(hash)?),
                    size,
                    cancellation,
                )?,
                "ffmpeg-inline-texture",
            ),
            TextureEncoding::Jpeg => (
                crate::texture_codec::TextureCodec::jpeg(registry.resolve(hash)?, size)?,
                "windows-wic-jpeg-texture",
            ),
            TextureEncoding::Webp => (
                crate::texture_codec::TextureCodec::webp(
                    registry.resolve(hash)?,
                    size,
                    self.limits.texture_max_pixel_bytes,
                )?,
                "rust-webp-texture",
            ),
        };
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if descriptor.encoding == TextureEncoding::Webp {
            // Browser WebP decodes through an associated-alpha bitmap; external texture copy restores straight RGB.
            for pixel in bytes.chunks_exact_mut(4) {
                let alpha = u32::from(pixel[3]);
                if alpha == 255 {
                    continue;
                }
                for channel in &mut pixel[..3] {
                    let associated = u32::from(*channel) * alpha / 255;
                    *channel = (associated * 255 + alpha / 2)
                        .checked_div(alpha)
                        .map_or(0, |value| value as u8);
                }
            }
        } else {
            crate::NativeStillDecoder::canvas_alpha_precision(&mut bytes);
        }
        if started.elapsed() > Duration::from_millis(self.limits.texture_timeout_ms) {
            return Err(MediaError::Limit("texture decode deadline exceeded".into()));
        }
        let decoded = DecodedTexture {
            receipt: NativeTextureReceipt {
                encoded: hash.clone(),
                encoding: descriptor.encoding,
                rgba_sha256: format!("{:x}", Sha256::digest(&bytes)),
                width: size.0,
                height: size.1,
                backend,
            },
            bytes: Arc::from(bytes),
        };
        self.stats.decodes = self.stats.decodes.saturating_add(1);
        let bytes = decoded.bytes.len() as u64;
        if self.stats.entry_limit > 0 && bytes <= self.stats.budget_bytes {
            while self.stats.resident_bytes > self.stats.budget_bytes - bytes
                || self.entries.len() >= self.stats.entry_limit
            {
                let oldest = self
                    .entries
                    .iter()
                    .min_by_key(|(_, (age, _))| age)
                    .map(|(key, _)| key.clone());
                let Some(oldest) = oldest else { break };
                if let Some((_, removed)) = self.entries.remove(&oldest) {
                    self.stats.resident_bytes -= removed.bytes.len() as u64;
                    self.stats.evictions = self.stats.evictions.saturating_add(1);
                }
            }
            self.entries
                .insert(hash.clone(), (self.clock, decoded.clone()));
            self.stats.resident_bytes += bytes;
            self.stats.entries = self.entries.len();
        }
        Ok(decoded)
    }
}

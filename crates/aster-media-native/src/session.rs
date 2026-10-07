use std::collections::BTreeMap;

use aster_render_ir::{MediaSample, ResourceDescriptor, ResourceHash, ResourceRegistry};
use aster_video::CancellationToken;
use serde::Serialize;

use crate::{DecodedStill, MediaError, NativeStillDecoder, NativeVideoDecoder, NativeVideoReceipt};

#[derive(Clone, Debug, clap::Args)]
pub struct MediaCacheLimits {
    /// Retained decoded pixel bytes; zero disables CPU frame retention.
    #[arg(long, default_value_t = 67_108_864)]
    pub media_cache_bytes: u64,
    /// Bounds receipt and key overhead independently of the retained pixel budget.
    #[arg(long, default_value_t = 256)]
    pub media_cache_entries: usize,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct MediaCacheStatistics {
    pub budget_bytes: u64,
    pub entry_limit: usize,
    pub resident_bytes: u64,
    pub entries: usize,
    pub hits: u64,
    pub misses: u64,
    pub decodes: u64,
    pub evictions: u64,
}

#[derive(Clone)]
pub struct DecodedMedia {
    pub image: DecodedStill,
    pub video: Option<NativeVideoReceipt>,
}

struct CachedMedia {
    decoded: DecodedMedia,
    age: u64,
}

/// A batch owns immutable grants. Reuse never expands source authorization or survives the job.
pub struct NativeMediaSession {
    still: NativeStillDecoder,
    video: Option<NativeVideoDecoder>,
    frames: BTreeMap<ResourceHash, CachedMedia>,
    stats: MediaCacheStatistics,
    clock: u64,
}

impl NativeMediaSession {
    pub fn new(
        still: NativeStillDecoder,
        video: Option<NativeVideoDecoder>,
        limits: MediaCacheLimits,
    ) -> Self {
        Self {
            still,
            video,
            frames: BTreeMap::new(),
            stats: MediaCacheStatistics {
                budget_bytes: limits.media_cache_bytes,
                entry_limit: limits.media_cache_entries,
                ..Default::default()
            },
            clock: 0,
        }
    }

    pub fn statistics(&self) -> MediaCacheStatistics {
        self.stats
    }

    pub fn decode(
        &mut self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<DecodedMedia, MediaError> {
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)? else {
            return Err(MediaError::Unsupported(
                "media frame descriptor required".into(),
            ));
        };
        // The frame's content hash includes its source, scope identity, sample and dimensions.
        registry.descriptor(&frame.source)?;
        self.clock = self.clock.saturating_add(1);
        if let Some(cached) = self.frames.get_mut(hash) {
            cached.age = self.clock;
            self.stats.hits = self.stats.hits.saturating_add(1);
            return Ok(cached.decoded.clone());
        }
        self.stats.misses = self.stats.misses.saturating_add(1);
        let decoded = if matches!(frame.sample, MediaSample::Video { .. }) {
            let decoded = self
                .video
                .as_ref()
                .ok_or_else(|| {
                    MediaError::Unsupported("--ffprobe is required for native video".into())
                })?
                .decode(hash, registry, cancellation)?;
            DecodedMedia {
                image: decoded.image,
                video: Some(decoded.receipt),
            }
        } else {
            DecodedMedia {
                image: self.still.decode(hash, registry, cancellation)?,
                video: None,
            }
        };
        self.stats.decodes = self.stats.decodes.saturating_add(1);
        self.retain(hash.clone(), &decoded);
        Ok(decoded)
    }

    fn retain(&mut self, hash: ResourceHash, decoded: &DecodedMedia) {
        let bytes = decoded.image.bytes.len() as u64;
        if self.stats.entry_limit == 0 || bytes > self.stats.budget_bytes {
            return;
        }
        while self.stats.resident_bytes > self.stats.budget_bytes - bytes
            || self.frames.len() >= self.stats.entry_limit
        {
            let oldest = self
                .frames
                .iter()
                .min_by_key(|(_, item)| item.age)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else { break };
            if let Some(removed) = self.frames.remove(&oldest) {
                self.stats.resident_bytes -= removed.decoded.image.bytes.len() as u64;
                self.stats.evictions = self.stats.evictions.saturating_add(1);
            }
        }
        self.frames.insert(
            hash,
            CachedMedia {
                decoded: decoded.clone(),
                age: self.clock,
            },
        );
        self.stats.resident_bytes += bytes;
        self.stats.entries = self.frames.len();
    }
}

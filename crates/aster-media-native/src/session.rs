use std::collections::{BTreeMap, BTreeSet};

use aster_render_ir::{
    BufferResourceDescriptor, ElementType, MediaSample, ResourceDescriptor, ResourceHash,
    ResourceKind, ResourceRegistry, VerifiedResource,
};
use aster_video::CancellationToken;
use serde::Serialize;

use crate::{
    MediaError, NativeImageReceipt, NativeStillDecoder, NativeVideoDecoder, NativeVideoReceipt,
    video::VideoSourceCacheStatistics,
};

#[derive(Clone, Debug, clap::Args)]
pub struct MediaCacheLimits {
    /// Retained decoded pixel bytes; zero disables CPU frame retention.
    #[arg(long, default_value_t = 268_435_456)]
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
    pub pixels: VerifiedResource,
    pub receipt: NativeImageReceipt,
    pub video: Option<NativeVideoReceipt>,
}

struct CachedMedia {
    decoded: DecodedMedia,
    age: u64,
}

/// A job owns immutable grants. New sources require explicit authenticated broker admission.
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

    pub(crate) fn admit_grants(
        &mut self,
        files: Vec<crate::StillAuthorization>,
        snapshots: Vec<crate::MediaSnapshotAuthorization>,
        limits: crate::SnapshotGrantLimits,
    ) -> Result<(), MediaError> {
        let grants = crate::authorization::MediaGrants::with_snapshots(files, snapshots, limits)?;
        self.still.authorizations.check_extension(&grants)?;
        if let Some(video) = &self.video {
            video.grants.check_extension(&grants)?;
        }
        self.still.authorizations.append_checked(grants.clone());
        if let Some(video) = &mut self.video {
            video.grants.append_checked(grants);
        }
        Ok(())
    }

    pub(crate) fn inspect_source(
        &mut self,
        source: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<crate::NativeVideoSourceInfo, MediaError> {
        self.video
            .as_mut()
            .ok_or_else(|| MediaError::Unsupported("video decoder absent".into()))?
            .inspect_source(source, registry, cancellation)
    }

    pub fn statistics(&self) -> MediaCacheStatistics {
        self.stats
    }

    pub fn video_source_statistics(&self) -> VideoSourceCacheStatistics {
        match &self.video {
            Some(video) => video.source_statistics(),
            None => VideoSourceCacheStatistics::default(),
        }
    }

    pub fn video_window_statistics(&self) -> crate::VideoWindowStatistics {
        match &self.video {
            Some(video) => video.window_statistics(),
            None => crate::VideoWindowStatistics::default(),
        }
    }

    pub fn decode(
        &mut self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<DecodedMedia, MediaError> {
        self.decode_protected(hash, registry, cancellation, &BTreeSet::new())
    }

    /// Protect this frame's working set from eviction by earlier misses in the same batch.
    pub fn decode_batch(
        &mut self,
        hashes: &[ResourceHash],
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<Vec<DecodedMedia>, MediaError> {
        let protected = hashes.iter().cloned().collect();
        hashes
            .iter()
            .map(|hash| self.decode_protected(hash, registry, cancellation, &protected))
            .collect()
    }

    fn decode_protected(
        &mut self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
        protected: &BTreeSet<ResourceHash>,
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
        let (image, video) = if matches!(frame.sample, MediaSample::Video { .. }) {
            let decoded = self
                .video
                .as_mut()
                .ok_or_else(|| {
                    MediaError::Unsupported("--ffprobe is required for native video".into())
                })?
                .decode(hash, registry, cancellation)?;
            (decoded.image, Some(decoded.receipt))
        } else {
            (self.still.decode(hash, registry, cancellation)?, None)
        };
        let length = u32::try_from(image.bytes.len())
            .map_err(|_| MediaError::Limit("decoded pixel resource length overflow".into()))?;
        let decoded = DecodedMedia {
            pixels: VerifiedResource::new(
                ResourceKind::Buffer,
                ResourceDescriptor::Buffer(BufferResourceDescriptor {
                    element_type: ElementType::U8,
                    element_count: length,
                    byte_length: length,
                }),
                image.bytes,
            )?,
            receipt: image.receipt,
            video,
        };
        self.stats.decodes = self.stats.decodes.saturating_add(1);
        self.retain(hash.clone(), &decoded, protected);
        Ok(decoded)
    }

    fn retain(
        &mut self,
        hash: ResourceHash,
        decoded: &DecodedMedia,
        protected: &BTreeSet<ResourceHash>,
    ) {
        let bytes = decoded.pixels.bytes().len() as u64;
        if self.stats.entry_limit == 0 || bytes > self.stats.budget_bytes {
            return;
        }
        while self.stats.resident_bytes > self.stats.budget_bytes - bytes
            || self.frames.len() >= self.stats.entry_limit
        {
            let oldest = self
                .frames
                .iter()
                .filter(|(key, _)| !protected.contains(*key))
                .min_by_key(|(_, item)| item.age)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else {
                self.stats.entries = self.frames.len();
                return;
            };
            if let Some(removed) = self.frames.remove(&oldest) {
                self.stats.resident_bytes -= removed.decoded.pixels.bytes().len() as u64;
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

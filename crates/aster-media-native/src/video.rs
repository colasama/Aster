use std::{collections::BTreeMap, path::PathBuf, sync::Arc, time::Duration};

use aster_render_ir::{
    FrameTime, MediaKind, MediaSample, MediaTextureFormat, ResourceDescriptor, ResourceHash,
    ResourceRegistry,
};
use aster_video::{
    CancellationToken, ColorMetadata, ColorPrimaries, DecodeLimits, FfmpegBackend, FfprobeBackend,
    MatrixCoefficients, ProbeLimits, Timebase, TransferFunction, VideoSnapshot, VideoSnapshotInput,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    DecodedStill, MediaError, MediaSnapshotAuthorization, NativeImageReceipt, SnapshotGrantLimits,
    StillAuthorization, authorization::MediaGrants, video_time::VideoTime,
    video_window::VideoDecodeWindow,
};

#[derive(Clone, Debug, clap::Args)]
pub struct VideoLimits {
    #[arg(long, default_value_t = 268_435_456)]
    pub video_max_source_bytes: u64,
    #[arg(long, default_value_t = 67_108_864)]
    pub video_max_pixel_bytes: u64,
    #[arg(long, default_value_t = 16384)]
    pub video_max_dimension: u32,
    #[arg(long, default_value_t = 30_000)]
    pub video_timeout_ms: u64,
    #[arg(long, default_value_t = 16_777_216)]
    pub video_max_index_bytes: usize,
    /// Aggregate retained source snapshots and presentation indices; zero disables reuse.
    #[arg(long, default_value_t = 268_435_456)]
    pub video_snapshot_cache_bytes: u64,
    #[arg(long, default_value_t = 8)]
    pub video_snapshot_cache_entries: usize,
    /// Aggregate bytes retained by a single presentation-order lookahead window.
    #[arg(long, default_value_t = 16_777_216)]
    pub video_decode_window_bytes: u64,
    /// One disables lookahead and preserves single-frame process isolation.
    #[arg(long, default_value_t = 128)]
    pub video_decode_window_frames: usize,
    /// Decode one next window within the existing aggregate byte and frame allowance.
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    pub video_decode_prefetch: bool,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct VideoSourceCacheStatistics {
    pub resident_bytes: u64,
    pub entries: usize,
    pub hits: u64,
    pub probes: u64,
    pub evictions: u64,
}

struct CachedVideoSource {
    snapshot: Arc<VideoSnapshot>,
    bytes: u64,
    age: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeVideoReceipt {
    pub frame: ResourceHash,
    pub requested_time: FrameTime,
    pub uploaded_time: FrameTime,
    pub frame_index: usize,
    pub presentation_timestamp: i64,
    pub duration: i64,
    pub timebase: Timebase,
    pub color: ColorMetadata,
    pub source_pixel_format: String,
    pub source_chroma_location: Option<String>,
    pub chroma_reconstruction: &'static str,
    pub measured_interop: &'static str,
    pub color_interpretation: &'static str,
}

pub struct DecodedVideo {
    pub image: DecodedStill,
    pub receipt: NativeVideoReceipt,
}

#[derive(Clone, Debug, Serialize)]
pub struct NativeVideoSourceInfo {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: f64,
}

pub struct NativeVideoDecoder {
    pub(crate) grants: MediaGrants,
    probe: FfprobeBackend,
    decoder: FfmpegBackend,
    limits: VideoLimits,
    sources: BTreeMap<ResourceHash, CachedVideoSource>,
    source_stats: VideoSourceCacheStatistics,
    clock: u64,
    window: VideoDecodeWindow,
}

impl NativeVideoDecoder {
    /// Resolve source timing from the same authenticated snapshot used by frame decoding.
    pub fn inspect_source(
        &mut self,
        source: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<NativeVideoSourceInfo, MediaError> {
        let ResourceDescriptor::MediaSource(descriptor) = registry.descriptor(source)? else {
            return Err(MediaError::Unsupported(
                "video source descriptor required".into(),
            ));
        };
        if descriptor.media_kind != MediaKind::Video {
            return Err(MediaError::Unsupported(
                "video source required for metadata".into(),
            ));
        }
        let (snapshot, _) = self.snapshot(
            source,
            &descriptor.authorization_scope,
            &descriptor.content_identity,
            cancellation,
        )?;
        Ok(NativeVideoSourceInfo {
            width: snapshot.stream.width,
            height: snapshot.stream.height,
            duration_seconds: snapshot.duration_seconds,
        })
    }

    pub fn new(
        ffmpeg: PathBuf,
        ffprobe: PathBuf,
        authorizations: Vec<StillAuthorization>,
        limits: VideoLimits,
    ) -> Result<Self, MediaError> {
        Self::with_snapshots(
            ffmpeg,
            ffprobe,
            authorizations,
            Vec::new(),
            SnapshotGrantLimits::default(),
            limits,
        )
    }

    pub fn with_snapshots(
        ffmpeg: PathBuf,
        ffprobe: PathBuf,
        authorizations: Vec<StillAuthorization>,
        snapshots: Vec<MediaSnapshotAuthorization>,
        snapshot_limits: SnapshotGrantLimits,
        limits: VideoLimits,
    ) -> Result<Self, MediaError> {
        if limits.video_max_source_bytes == 0
            || limits.video_max_source_bytes == u64::MAX
            || limits.video_max_pixel_bytes == 0
            || limits.video_max_dimension == 0
            || limits.video_timeout_ms == 0
            || limits.video_max_index_bytes < 1024
            || limits.video_snapshot_cache_bytes > 32 * 1024_u64.pow(3)
            || limits.video_snapshot_cache_entries > 1024
            || limits.video_decode_window_bytes > 67_108_864
            || !(1..=128).contains(&limits.video_decode_window_frames)
        {
            return Err(MediaError::Limit(
                "positive bounded video limits required".into(),
            ));
        }
        let metadata = aster_video::MetadataLimits {
            max_dimension: limits.video_max_dimension,
            max_probe_bytes: limits.video_max_index_bytes,
            ..Default::default()
        };
        let probe = FfprobeBackend::with_limits(
            ffprobe,
            ProbeLimits {
                metadata: metadata.clone(),
                max_media_bytes: limits.video_max_source_bytes,
                max_stdout_bytes: limits.video_max_index_bytes,
                timeout: Duration::from_millis(limits.video_timeout_ms),
                ..Default::default()
            },
        );
        let decoder = FfmpegBackend::with_limits(
            ffmpeg,
            DecodeLimits {
                metadata,
                max_media_bytes: limits.video_max_source_bytes,
                max_frame_bytes: usize::try_from(limits.video_max_pixel_bytes)
                    .map_err(|_| MediaError::Limit("video pixel limit overflow".into()))?,
                timeout: Duration::from_millis(limits.video_timeout_ms),
                ..Default::default()
            },
        );
        Ok(Self {
            grants: MediaGrants::with_snapshots(authorizations, snapshots, snapshot_limits)?,
            probe,
            decoder,
            window: VideoDecodeWindow::new(
                limits
                    .video_decode_window_bytes
                    .min(limits.video_max_pixel_bytes),
                limits.video_decode_window_frames,
                limits.video_decode_prefetch,
            ),
            limits,
            sources: BTreeMap::new(),
            source_stats: VideoSourceCacheStatistics::default(),
            clock: 0,
        })
    }

    pub fn decode(
        &mut self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<DecodedVideo, MediaError> {
        let result = self.decode_authorized(hash, registry, cancellation);
        if result.is_err() {
            self.window.clear();
        }
        result
    }

    fn decode_authorized(
        &mut self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<DecodedVideo, MediaError> {
        let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)? else {
            return Err(MediaError::Unsupported(
                "video frame descriptor required".into(),
            ));
        };
        self.window.discard_other_source(&frame.source);
        let ResourceDescriptor::MediaSource(source) = registry.descriptor(&frame.source)? else {
            return Err(MediaError::Unsupported(
                "video source descriptor required".into(),
            ));
        };
        let MediaSample::Video {
            requested_time,
            uploaded_time,
        } = frame.sample
        else {
            return Err(MediaError::Unsupported("video sample required".into()));
        };
        if source.media_kind != MediaKind::Video
            || frame.format != MediaTextureFormat::Rgba8UnormSrgb
        {
            return Err(MediaError::Unsupported("SDR video source required".into()));
        }
        let pixels = u64::from(frame.width) * u64::from(frame.height);
        if frame.width > self.limits.video_max_dimension
            || frame.height > self.limits.video_max_dimension
            || pixels * 4 > self.limits.video_max_pixel_bytes
        {
            return Err(MediaError::Limit(
                "decoded video exceeds extent or byte budget".into(),
            ));
        }
        let requested = VideoTime::new(requested_time)?;
        let uploaded = VideoTime::new(uploaded_time)?;
        let (snapshot, source_sha256) = self.snapshot(
            &frame.source,
            &source.authorization_scope,
            &source.content_identity,
            cancellation,
        )?;
        let stream = &snapshot.stream;
        if stream.width != frame.width || stream.height != frame.height {
            return Err(MediaError::Unsupported(
                "encoded video dimensions differ from supplied frame".into(),
            ));
        }
        // Chromium's SD fallback is SMPTE 170M limited. Keep explicit unsupported tags rejected,
        // and leave HD untagged sources outside this measured compatibility class.
        let untagged_sd = snapshot.untagged_sdr && stream.width <= 1024 && stream.height <= 576;
        let tagged_sdr = stream.color.primaries == ColorPrimaries::Bt709
            && stream.color.matrix == MatrixCoefficients::Bt709
            && matches!(
                stream.color.transfer,
                TransferFunction::Bt709 | TransferFunction::Srgb
            );
        if stream.codec != "h264"
            || snapshot.pixel_format != "yuv420p"
            || !(tagged_sdr || untagged_sd)
        {
            return Err(MediaError::Unsupported(
                "native video requires tagged SDR BT.709 or untagged limited SD H.264 4:2:0".into(),
            ));
        }
        let index = requested.select(&snapshot.frames, stream.timebase)?;
        if index != uploaded.select(&snapshot.frames, stream.timebase)? {
            return Err(MediaError::Unsupported(
                "requested and uploaded video frame identities differ".into(),
            ));
        }
        let point = &snapshot.frames[index];
        let source_retained = self
            .sources
            .get(&frame.source)
            .is_some_and(|cached| Arc::ptr_eq(&cached.snapshot, &snapshot));
        let bytes = self.window.decode(
            &frame.source,
            &snapshot,
            index,
            &self.decoder,
            cancellation,
            source_retained,
        )?;
        let image = DecodedStill {
            receipt: NativeImageReceipt {
                frame: hash.clone(),
                source: frame.source.clone(),
                source_sha256,
                rgba_sha256: format!("{:x}", Sha256::digest(&bytes)),
                width: frame.width,
                height: frame.height,
                backend: "ffmpeg-video-snapshot",
                format: frame.format,
            },
            bytes,
        };
        Ok(DecodedVideo {
            image,
            receipt: NativeVideoReceipt {
                frame: hash.clone(),
                requested_time,
                uploaded_time,
                frame_index: index,
                presentation_timestamp: point.best_effort_timestamp,
                duration: point.duration,
                timebase: stream.timebase,
                color: stream.color,
                source_pixel_format: snapshot.pixel_format.clone(),
                source_chroma_location: snapshot.chroma_location.clone(),
                chroma_reconstruction: "browser-compatible centered bilinear via 4:4:4",
                measured_interop: "cpu_copy",
                color_interpretation: if untagged_sd {
                    "untagged SD: SMPTE 170M limited"
                } else {
                    "explicit source SDR tags"
                },
            },
        })
    }

    pub fn source_statistics(&self) -> VideoSourceCacheStatistics {
        self.source_stats
    }

    pub fn window_statistics(&self) -> crate::VideoWindowStatistics {
        self.window.statistics()
    }

    fn snapshot(
        &mut self,
        hash: &ResourceHash,
        scope: &str,
        identity: &str,
        cancellation: &CancellationToken,
    ) -> Result<(Arc<VideoSnapshot>, String), MediaError> {
        self.clock = self.clock.saturating_add(1);
        if let Some(cached) = self.sources.get_mut(hash) {
            // Reauthenticate the caller source before reusing our private snapshot and index.
            let source = self.grants.copy_video_to(
                hash,
                scope,
                identity,
                self.limits.video_max_source_bytes,
                cancellation,
                &mut std::io::sink(),
            )?;
            cached.age = self.clock;
            self.source_stats.hits = self.source_stats.hits.saturating_add(1);
            return Ok((Arc::clone(&cached.snapshot), source.sha256));
        }
        let mut input =
            VideoSnapshotInput::new(self.limits.video_max_source_bytes, cancellation.clone())?;
        let source = self.grants.copy_video_to(
            hash,
            scope,
            identity,
            self.limits.video_max_source_bytes,
            cancellation,
            &mut input,
        )?;
        let snapshot = Arc::new(self.probe.video_snapshot_input(
            input,
            self.limits.video_max_pixel_bytes / 4,
            cancellation,
        )?);
        self.source_stats.probes = self.source_stats.probes.saturating_add(1);
        let retained_bytes = source
            .bytes
            .checked_add(
                (snapshot.frames.capacity() * std::mem::size_of::<aster_video::PresentationFrame>())
                    as u64,
            )
            .ok_or_else(|| MediaError::Limit("video snapshot accounting overflow".into()))?;
        if self.limits.video_snapshot_cache_entries == 0
            || retained_bytes > self.limits.video_snapshot_cache_bytes
        {
            return Ok((snapshot, source.sha256));
        }
        while self.sources.len() >= self.limits.video_snapshot_cache_entries
            || self.source_stats.resident_bytes
                > self.limits.video_snapshot_cache_bytes - retained_bytes
        {
            let oldest = self
                .sources
                .iter()
                .min_by_key(|(_, value)| value.age)
                .map(|(key, _)| key.clone());
            let Some(oldest) = oldest else { break };
            if let Some(removed) = self.sources.remove(&oldest) {
                self.source_stats.resident_bytes -= removed.bytes;
                self.source_stats.evictions = self.source_stats.evictions.saturating_add(1);
            }
        }
        self.sources.insert(
            hash.clone(),
            CachedVideoSource {
                snapshot: Arc::clone(&snapshot),
                bytes: retained_bytes,
                age: self.clock,
            },
        );
        self.source_stats.resident_bytes += retained_bytes;
        self.source_stats.entries = self.sources.len();
        Ok((snapshot, source.sha256))
    }
}

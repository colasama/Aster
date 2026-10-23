mod admission;
mod clock;
use crate::{
    DecodedMedia, MediaCacheLimits, MediaError, MediaSnapshotAuthorization, NativeMediaSession,
    NativeStillDecoder, NativeVideoDecoder, SnapshotGrantLimits, StillAuthorization, StillLimits,
    VideoLimits,
};
use aster_project::{MediaSourceReader, ProjectMediaBinding, ProjectMediaPayload};
use aster_render_ir::{
    CompositionIdentity, MediaFrameDescriptor, MediaKind, MediaSample, MediaSourceDescriptor,
    MediaTextureFormat, ResourceDescriptor, ResourceKind, ResourceLimits, ResourceRegistry,
    VerifiedResource,
};
use aster_video::CancellationToken;
use clock::ProjectVideoClock;
use std::{collections::BTreeMap, path::PathBuf};

pub struct ProjectMediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

#[derive(Clone, Debug, clap::Args)]
pub struct ProjectMediaLimits {
    #[command(flatten)]
    pub still: StillLimits,
    #[command(flatten)]
    pub video: VideoLimits,
    #[command(flatten)]
    pub cache: MediaCacheLimits,
    #[command(flatten)]
    pub snapshots: SnapshotGrantLimits,
    #[arg(long, default_value_t = 50_000)]
    pub project_media_sources: usize,
    #[arg(long, default_value_t = 65_536)]
    pub project_media_instances: usize,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProjectMediaSourceInfo {
    pub kind: MediaKind,
    pub width: u32,
    pub height: u32,
    pub duration: Option<f64>,
}

struct ProjectSource {
    binding: ProjectMediaBinding,
    resource: VerifiedResource,
    info: ProjectMediaSourceInfo,
    members: BTreeMap<i64, String>,
}

pub struct ProjectMediaFrame {
    pub source: VerifiedResource,
    pub frame: VerifiedResource,
    pub decoded: DecodedMedia,
}

#[derive(Clone)]
pub struct PreparedProjectMediaFrame {
    pub source: VerifiedResource,
    pub frame: VerifiedResource,
}

/// One export job owns admitted source grants, bounded decode caches and retained video clocks.
pub struct NativeProjectMediaSession {
    sources: BTreeMap<String, ProjectSource>,
    decoder: NativeMediaSession,
    video_clock: ProjectVideoClock,
    limits: ProjectMediaLimits,
    scope: String,
    poisoned: bool,
}

impl NativeProjectMediaSession {
    /// Decode supplied frame identities only within this job's authenticated project sources.
    pub fn decode_frames(
        &mut self,
        frames: &[aster_render_ir::ResourceHash],
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<Vec<DecodedMedia>, MediaError> {
        if self.poisoned {
            return Err(MediaError::Authorization(
                "project media session is poisoned".into(),
            ));
        }
        for hash in frames {
            let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)? else {
                return Err(MediaError::Authorization(
                    "project frame descriptor absent".into(),
                ));
            };
            let ResourceDescriptor::MediaSource(source) = registry.descriptor(&frame.source)?
            else {
                return Err(MediaError::Authorization(
                    "project source descriptor absent".into(),
                ));
            };
            let CompositionIdentity::Unicode(id) = &source.source_id else {
                return Err(MediaError::Authorization(
                    "project source identity absent".into(),
                ));
            };
            if self
                .sources
                .get(id)
                .is_none_or(|admitted| admitted.resource.request().hash != frame.source)
            {
                return Err(MediaError::Authorization(
                    "frame source is outside project admission".into(),
                ));
            }
        }
        self.decoder.decode_batch(frames, registry, cancellation)
    }

    pub fn new(
        bindings: Vec<ProjectMediaBinding>,
        reader: &mut MediaSourceReader,
        scope: &str,
        tools: ProjectMediaTools,
        limits: ProjectMediaLimits,
        cancellation: &CancellationToken,
    ) -> Result<Self, MediaError> {
        if scope.is_empty()
            || scope.len() > 4096
            || limits.project_media_sources == 0
            || bindings.len() > limits.project_media_sources
            || limits.project_media_instances == 0
        {
            return Err(MediaError::Limit(
                "bounded project media sources and scope required".into(),
            ));
        }
        let video = NativeVideoDecoder::with_snapshots(
            tools.ffmpeg.clone(),
            tools.ffprobe,
            Vec::new(),
            Vec::new(),
            limits.snapshots.clone(),
            limits.video.clone(),
        )?;
        let still = NativeStillDecoder::with_snapshots(
            tools.ffmpeg,
            Vec::new(),
            Vec::new(),
            limits.snapshots.clone(),
            limits.still.clone(),
        )?;
        let mut session = Self {
            sources: BTreeMap::new(),
            decoder: NativeMediaSession::new(still, Some(video), limits.cache.clone()),
            video_clock: ProjectVideoClock::new(limits.project_media_instances),
            limits,
            scope: scope.to_owned(),
            poisoned: false,
        };
        session.admit(bindings, reader, cancellation)?;
        Ok(session)
    }

    pub fn source_info(&self, source_id: &str) -> Result<ProjectMediaSourceInfo, MediaError> {
        if self.poisoned {
            return Err(MediaError::Authorization(
                "project media session is poisoned".into(),
            ));
        }
        self.sources
            .get(source_id)
            .map(|s| s.info.clone())
            .ok_or_else(|| MediaError::Authorization("project source is not admitted".into()))
    }

    fn describe(
        &self,
        source_id: &str,
        instance_id: &str,
        source_time: f64,
        playing: bool,
    ) -> Result<(PreparedProjectMediaFrame, MediaSample), MediaError> {
        if self.poisoned {
            return Err(MediaError::Authorization(
                "project media session is poisoned".into(),
            ));
        }
        if !source_time.is_finite() {
            return Err(MediaError::Unsupported(
                "finite source time required".into(),
            ));
        }
        let source = self
            .sources
            .get(source_id)
            .ok_or_else(|| MediaError::Authorization("project source is not admitted".into()))?;
        let sample = match source.info.kind {
            MediaKind::Image => MediaSample::Image,
            MediaKind::Sequence => {
                let Some(ProjectMediaPayload::ImageSequence(sequence)) =
                    source.binding.payload.as_deref()
                else {
                    return Err(MediaError::Unsupported("sequence payload absent".into()));
                };
                let selected = sequence.select(
                    source_time
                        .max(0.0)
                        .min(source.info.duration.unwrap_or(0.0)),
                )?;
                MediaSample::Sequence {
                    frame: selected.actual_frame,
                    file_identity: source
                        .members
                        .get(&selected.actual_frame)
                        .cloned()
                        .ok_or_else(|| {
                            MediaError::Authorization("sequence member is not admitted".into())
                        })?,
                }
            }
            MediaKind::Video => self.video_clock.sample(
                instance_id,
                &source.resource.request().hash,
                source_time,
                source.info.duration.unwrap_or(0.0),
                playing,
            )?,
            MediaKind::Raster => {
                return Err(MediaError::Unsupported(
                    "retained raster broker required".into(),
                ));
            }
        };
        let frame = VerifiedResource::new(
            ResourceKind::MediaFrame,
            ResourceDescriptor::MediaFrame(MediaFrameDescriptor {
                source: source.resource.request().hash.clone(),
                sample: sample.clone(),
                width: source.info.width,
                height: source.info.height,
                format: MediaTextureFormat::Rgba8UnormSrgb,
            }),
            vec![],
        )?;
        Ok((
            PreparedProjectMediaFrame {
                source: source.resource.clone(),
                frame,
            },
            sample,
        ))
    }

    /// Plan metadata from native source time without decoding pixels or retaining GPU resources.
    pub fn prepare(
        &mut self,
        source_id: &str,
        instance_id: &str,
        source_time: f64,
        playing: bool,
    ) -> Result<PreparedProjectMediaFrame, MediaError> {
        let (frame, sample) = self.describe(source_id, instance_id, source_time, playing)?;
        self.video_clock
            .commit(instance_id, &frame.source.request().hash, &sample)?;
        Ok(frame)
    }

    /// The caller supplies source time evaluated natively from the owning layer and composition.
    pub fn decode(
        &mut self,
        source_id: &str,
        instance_id: &str,
        source_time: f64,
        playing: bool,
        cancellation: &CancellationToken,
    ) -> Result<ProjectMediaFrame, MediaError> {
        let (frame, sample) = self.describe(source_id, instance_id, source_time, playing)?;
        let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
        registry.put_verified(frame.source.clone())?;
        registry.put_verified(frame.frame.clone())?;
        let decoded = self
            .decoder
            .decode(&frame.frame.request().hash, &registry, cancellation)?;
        self.video_clock
            .commit(instance_id, &frame.source.request().hash, &sample)?;
        Ok(ProjectMediaFrame {
            source: frame.source,
            frame: frame.frame,
            decoded,
        })
    }
}

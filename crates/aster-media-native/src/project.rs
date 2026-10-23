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
}

impl NativeProjectMediaSession {
    /// Decode supplied frame identities only within this job's authenticated project sources.
    pub fn decode_frames(
        &mut self,
        frames: &[aster_render_ir::ResourceHash],
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<Vec<DecodedMedia>, MediaError> {
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
        let mut sources = BTreeMap::new();
        let mut files = Vec::new();
        let mut snapshots = Vec::new();
        let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
        for binding in bindings {
            if cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            let kind = match binding.source.kind.as_str() {
                "still" => MediaKind::Image,
                "video" => MediaKind::Video,
                "imageSequence" => MediaKind::Sequence,
                _ => {
                    return Err(MediaError::Unsupported(
                        "project decoder requires still, video or sequence sources".into(),
                    ));
                }
            };
            let source_id = binding.source.id.clone();
            if sources.contains_key(&source_id) {
                return Err(MediaError::Authorization("duplicate project source".into()));
            }
            let maximum = if kind == MediaKind::Video {
                limits.video.video_max_source_bytes
            } else {
                limits.still.still_max_source_bytes
            };
            let mut ordinary = if kind == MediaKind::Sequence {
                None
            } else {
                Some(binding.read(reader, None, maximum)?)
            };
            // The project authenticates historical locator identities before granting decoder bytes.
            let content_identity = match (binding.payload.as_deref(), ordinary.as_ref()) {
                (
                    Some(ProjectMediaPayload::Still(p) | ProjectMediaPayload::Video(p)),
                    Some(snapshot),
                ) if p.legacy_locator.is_some() => format!("sha256:{}", snapshot.sha256),
                _ => binding.source.content_identity.clone(),
            };
            let resource = VerifiedResource::new(
                ResourceKind::MediaSource,
                ResourceDescriptor::MediaSource(MediaSourceDescriptor {
                    source_id: CompositionIdentity::Unicode(source_id.clone()),
                    content_identity,
                    authorization_scope: scope.to_owned(),
                    media_kind: kind,
                }),
                vec![],
            )?;
            let mut info = ProjectMediaSourceInfo {
                kind,
                width: 0,
                height: 0,
                duration: None,
            };
            if kind != MediaKind::Video {
                let dimensions = [binding.source.width.value(), binding.source.height.value()];
                let mut extent = [0_u32; 2];
                for (index, dimension) in dimensions.into_iter().enumerate() {
                    let value = dimension
                        .and_then(|n| n.as_f64())
                        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= 16384.0)
                        .ok_or_else(|| {
                            MediaError::Unsupported("bounded image dimensions required".into())
                        })?;
                    extent[index] = value as u32;
                }
                [info.width, info.height] = extent;
            }
            let members = match binding.payload.as_deref() {
                Some(ProjectMediaPayload::ImageSequence(sequence)) => {
                    info.duration = Some(
                        (sequence.end_frame - sequence.start_frame + 1) as f64
                            * sequence.frame_rate.denominator as f64
                            / sequence.frame_rate.numerator as f64,
                    );
                    sequence
                        .frames
                        .iter()
                        .map(|f| Some(f.frame))
                        .collect::<Vec<_>>()
                }
                _ => vec![None],
            };
            let mut identities = BTreeMap::new();
            for member in members {
                if cancellation.is_cancelled() {
                    return Err(aster_video::FfmpegError::Cancelled.into());
                }
                let bytes = match ordinary.take() {
                    Some(snapshot) => snapshot,
                    None => binding.read(reader, member, maximum)?,
                };
                if let Some(frame) = member {
                    identities.insert(frame, bytes.byte_identity.clone());
                }
                if let Some(path) = bytes.path {
                    files.push(StillAuthorization {
                        source: resource.request().hash.clone(),
                        sequence_frame: member,
                        scope: scope.to_owned(),
                        path,
                        sha256: bytes.sha256,
                    });
                } else {
                    snapshots.push(MediaSnapshotAuthorization {
                        source: resource.request().hash.clone(),
                        sequence_frame: member,
                        scope: scope.to_owned(),
                        bytes: bytes.bytes.into(),
                        sha256: bytes.sha256,
                    });
                }
            }
            registry.put_verified(resource.clone())?;
            sources.insert(
                source_id,
                ProjectSource {
                    binding,
                    resource,
                    info,
                    members: identities,
                },
            );
        }
        let mut video = NativeVideoDecoder::with_snapshots(
            tools.ffmpeg.clone(),
            tools.ffprobe,
            files.clone(),
            snapshots.clone(),
            limits.snapshots.clone(),
            limits.video,
        )?;
        for source in sources
            .values_mut()
            .filter(|s| s.info.kind == MediaKind::Video)
        {
            let metadata =
                video.inspect_source(&source.resource.request().hash, &registry, cancellation)?;
            if !metadata.duration_seconds.is_finite() || metadata.duration_seconds <= 0.0 {
                return Err(MediaError::Unsupported(
                    "positive finite video duration required".into(),
                ));
            }
            source.info.width = metadata.width;
            source.info.height = metadata.height;
            source.info.duration = Some(metadata.duration_seconds);
        }
        let still = NativeStillDecoder::with_snapshots(
            tools.ffmpeg,
            files,
            snapshots,
            limits.snapshots,
            limits.still,
        )?;
        Ok(Self {
            sources,
            decoder: NativeMediaSession::new(still, Some(video), limits.cache),
            video_clock: ProjectVideoClock::new(limits.project_media_instances),
        })
    }

    pub fn source_info(&self, source_id: &str) -> Result<ProjectMediaSourceInfo, MediaError> {
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

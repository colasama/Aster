use std::{path::PathBuf, time::Duration};

use aster_render_ir::{
    FrameTime, MediaKind, MediaSample, MediaTextureFormat, ResourceDescriptor, ResourceHash,
    ResourceRegistry,
};
use aster_video::{
    CancellationToken, ColorMetadata, ColorPrimaries, DecodeLimits, FfmpegBackend, FfprobeBackend,
    MatrixCoefficients, ProbeLimits, Timebase, TransferFunction,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    DecodedStill, MediaError, NativeImageReceipt, StillAuthorization, authorization::MediaGrants,
    video_time::VideoTime,
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
}

pub struct DecodedVideo {
    pub image: DecodedStill,
    pub receipt: NativeVideoReceipt,
}

pub struct NativeVideoDecoder {
    grants: MediaGrants,
    probe: FfprobeBackend,
    decoder: FfmpegBackend,
    limits: VideoLimits,
}

impl NativeVideoDecoder {
    pub fn new(
        ffmpeg: PathBuf,
        ffprobe: PathBuf,
        authorizations: Vec<StillAuthorization>,
        limits: VideoLimits,
    ) -> Result<Self, MediaError> {
        if limits.video_max_source_bytes == 0
            || limits.video_max_source_bytes == u64::MAX
            || limits.video_max_pixel_bytes == 0
            || limits.video_max_dimension == 0
            || limits.video_timeout_ms == 0
            || limits.video_max_index_bytes < 1024
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
            grants: MediaGrants::new(authorizations)?,
            probe,
            decoder,
            limits,
        })
    }

    pub fn decode(
        &self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
        cancellation: &CancellationToken,
    ) -> Result<DecodedVideo, MediaError> {
        let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)? else {
            return Err(MediaError::Unsupported(
                "video frame descriptor required".into(),
            ));
        };
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
        let source = self.grants.read(
            &frame.source,
            &source.authorization_scope,
            None,
            &source.content_identity,
            self.limits.video_max_source_bytes,
            cancellation,
        )?;
        let snapshot = self.probe.video_snapshot(
            &source.bytes,
            self.limits.video_max_pixel_bytes / 4,
            cancellation,
        )?;
        let stream = &snapshot.stream;
        if stream.width != frame.width || stream.height != frame.height {
            return Err(MediaError::Unsupported(
                "encoded video dimensions differ from supplied frame".into(),
            ));
        }
        if stream.codec != "h264"
            || snapshot.pixel_format != "yuv420p"
            || stream.color.primaries != ColorPrimaries::Bt709
            || stream.color.matrix != MatrixCoefficients::Bt709
            || !matches!(
                stream.color.transfer,
                TransferFunction::Bt709 | TransferFunction::Srgb
            )
        {
            return Err(MediaError::Unsupported(
                "native video requires tagged SDR BT.709 H.264 4:2:0".into(),
            ));
        }
        let index = requested.select(&snapshot.frames, stream.timebase)?;
        if index != uploaded.select(&snapshot.frames, stream.timebase)? {
            return Err(MediaError::Unsupported(
                "requested and uploaded video frame identities differ".into(),
            ));
        }
        let point = &snapshot.frames[index];
        let bytes = self
            .decoder
            .decode_snapshot_frame(&snapshot, index, cancellation)?;
        let image = DecodedStill {
            receipt: NativeImageReceipt {
                frame: hash.clone(),
                source: frame.source.clone(),
                source_sha256: source.sha256,
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
            },
        })
    }
}

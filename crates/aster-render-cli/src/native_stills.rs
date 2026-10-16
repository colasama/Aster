use crate::ir::IrArgs;
use aster_media_native::{
    MediaCacheLimits, MediaCacheStatistics, NativeImageReceipt, NativeMediaSession,
    NativeStillDecoder, NativeVideoDecoder, NativeVideoReceipt, StillAuthorization, StillLimits,
    VideoLimits,
};
use aster_render_ir::{
    DecodeLimits, FplnCodec, MediaSample, OwnedFpln, PlanSlice, PrecompositionMediaPixels,
    ResourceDescriptor, ResourceHash, ResourceRegistry,
};
use clap::Args;
use std::path::PathBuf;

#[derive(Debug, Args)]
pub struct NativeStillArgs {
    /// Explicit source/member/path/scope/SHA-256 grants for native file decoding.
    #[arg(long, requires = "ffmpeg")]
    media_authorizations: Option<PathBuf>,
    /// Existing packaged FFmpeg executable; no download or codec substitution occurs.
    #[arg(long, requires = "media_authorizations")]
    ffmpeg: Option<PathBuf>,
    /// Packaged FFprobe for exact native video presentation-frame indexing.
    #[arg(long, requires = "media_authorizations")]
    ffprobe: Option<PathBuf>,
    #[command(flatten)]
    limits: StillLimits,
    #[command(flatten)]
    video_limits: VideoLimits,
    #[command(flatten)]
    cache_limits: MediaCacheLimits,
}

#[derive(Default)]
pub struct NativeStillResources {
    pub pixels: Vec<PrecompositionMediaPixels>,
    pub receipts: Vec<NativeImageReceipt>,
    pub video_receipts: Vec<NativeVideoReceipt>,
    pub decode_cache: MediaCacheStatistics,
    pub video_source_cache: aster_media_native::VideoSourceCacheStatistics,
    pub video_decode_window: aster_media_native::VideoWindowStatistics,
    installed: Vec<ResourceHash>,
}

impl NativeStillArgs {
    pub fn session(
        &self,
        limits: &DecodeLimits,
    ) -> Result<Option<NativeMediaSession>, Box<dyn std::error::Error>> {
        let Some(path) = &self.media_authorizations else {
            return Ok(None);
        };
        let authorizations: Vec<StillAuthorization> =
            serde_json::from_slice(&IrArgs::read_bounded(path, limits)?)?;
        let still = NativeStillDecoder::new(
            self.ffmpeg.clone().ok_or("FFmpeg executable absent")?,
            authorizations.clone(),
            self.limits.clone(),
        )?;
        let video = self
            .ffprobe
            .as_ref()
            .map(|ffprobe| {
                NativeVideoDecoder::new(
                    self.ffmpeg.clone().ok_or("FFmpeg executable absent")?,
                    ffprobe.clone(),
                    authorizations,
                    self.video_limits.clone(),
                )
                .map_err(Into::<Box<dyn std::error::Error>>::into)
            })
            .transpose()?;
        Ok(Some(NativeMediaSession::new(
            still,
            video,
            self.cache_limits.clone(),
        )))
    }
}

impl NativeStillResources {
    pub fn install(
        session: Option<&mut NativeMediaSession>,
        plan: &OwnedFpln,
        registry: &mut ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut result = Self::default();
        let Some(session) = session else {
            return Ok(result);
        };
        let Some(PlanSlice::FrameBundle(bundle)) = plan.metadata.slices.first() else {
            return Err("native media requires a complete frame bundle".into());
        };
        Self::validate_rasters(&bundle.media_pixels, registry)?;
        if let Some(hash) = &bundle.precompositions {
            let nested = FplnCodec::decode(registry.resolve(hash)?.to_vec(), limits)?;
            let Some(PlanSlice::PrecompositionBundle(surfaces)) = nested.metadata.slices.first()
            else {
                return Err("native media requires a complete precomposition bundle".into());
            };
            Self::validate_rasters(&surfaces.media_pixels, registry)?;
        }
        let mut requested = 0_u64;
        let mut frames = Vec::new();
        for hash in &plan.metadata.resources {
            if let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)? {
                if matches!(frame.sample, MediaSample::Raster(_)) {
                    continue;
                }
                requested = requested
                    .checked_add(
                        u64::from(frame.width)
                            * u64::from(frame.height)
                            * u64::from(frame.format.bytes_per_pixel()),
                    )
                    .ok_or("native still allocation overflow")?;
                frames.push(hash.clone());
            }
        }
        let stats = registry.statistics();
        if requested > stats.budget_bytes.saturating_sub(stats.used_bytes) {
            return Err("native decoded images exceed resource byte budget".into());
        }
        let cancellation = aster_video::CancellationToken::default();
        let mut staged = Vec::new();
        let decoded = session.decode_batch(&frames, registry, &cancellation)?;
        for (frame, decoded) in frames.into_iter().zip(decoded) {
            if let Some(receipt) = decoded.video {
                result.video_receipts.push(receipt);
            }
            let pixels = decoded.pixels.request().hash.clone();
            staged.push(decoded.pixels);
            result
                .pixels
                .push(PrecompositionMediaPixels { frame, pixels });
            result.receipts.push(decoded.receipt);
        }
        for pixels in staged {
            let hash = pixels.request().hash.clone();
            let added = registry.descriptor(&hash).is_err();
            if let Err(error) = registry.put_verified(pixels) {
                result.release(registry)?;
                return Err(error.into());
            }
            if added {
                result.installed.push(hash);
            }
        }
        result.decode_cache = session.statistics();
        result.video_source_cache = session.video_source_statistics();
        result.video_decode_window = session.video_window_statistics();
        Ok(result)
    }

    /// Retire temporary decoded bytes without evicting an identical caller-owned buffer.
    pub fn release(
        &mut self,
        registry: &mut ResourceRegistry,
    ) -> Result<(), aster_render_ir::IrError> {
        for hash in self.installed.drain(..) {
            registry.evict(&hash)?;
        }
        Ok(())
    }

    fn validate_rasters(
        pixels: &[PrecompositionMediaPixels],
        registry: &ResourceRegistry,
    ) -> Result<(), Box<dyn std::error::Error>> {
        for pixel in pixels {
            if !matches!(registry.descriptor(&pixel.frame)?, ResourceDescriptor::MediaFrame(frame)
                if matches!(frame.sample, MediaSample::Raster(_)))
            {
                return Err("native media cannot accept supplied file-media pixels".into());
            }
        }
        Ok(())
    }
}

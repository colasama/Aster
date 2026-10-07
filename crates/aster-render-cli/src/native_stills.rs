use crate::ir::IrArgs;
use aster_media_native::{NativeImageReceipt, NativeStillDecoder, StillAuthorization, StillLimits};
use aster_render_ir::{
    BufferResourceDescriptor, DecodeLimits, ElementType, OwnedFpln, PlanSlice,
    PrecompositionMediaPixels, PutResource, ResourceDescriptor, ResourceHash, ResourceKind,
    ResourceRegistry,
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
    #[command(flatten)]
    limits: StillLimits,
}

pub struct NativeStillResources {
    pub pixels: Vec<PrecompositionMediaPixels>,
    pub receipts: Vec<NativeImageReceipt>,
}

impl NativeStillArgs {
    pub fn install(
        &self,
        plan: &OwnedFpln,
        registry: &mut ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<NativeStillResources, Box<dyn std::error::Error>> {
        let mut result = NativeStillResources {
            pixels: Vec::new(),
            receipts: Vec::new(),
        };
        let Some(path) = &self.media_authorizations else {
            return Ok(result);
        };
        let Some(PlanSlice::FrameBundle(bundle)) = plan.metadata.slices.first() else {
            return Err("native media requires a complete frame bundle".into());
        };
        if !bundle.media_pixels.is_empty()
            || bundle.precompositions.is_some()
            || !bundle.temporal.is_empty()
        {
            return Err("native still decode requires original root plans without supplied pixel payloads or derived surfaces".into());
        }
        let authorizations: Vec<StillAuthorization> =
            serde_json::from_slice(&IrArgs::read_bounded(path, limits)?)?;
        let decoder = NativeStillDecoder::new(
            self.ffmpeg.clone().ok_or("FFmpeg executable absent")?,
            authorizations,
            self.limits.clone(),
        )?;
        let mut requested = 0_u64;
        let mut frames = Vec::new();
        for hash in &plan.metadata.resources {
            if let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)? {
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
        for frame in frames {
            let decoded = decoder.decode(&frame, registry, &cancellation)?;
            let length = u32::try_from(decoded.bytes.len())?;
            let descriptor = BufferResourceDescriptor {
                element_type: ElementType::U8,
                element_count: length,
                byte_length: length,
            };
            let pixels = ResourceHash::for_buffer(&descriptor, &decoded.bytes)?;
            staged.push((
                PutResource {
                    hash: pixels.clone(),
                    kind: ResourceKind::Buffer,
                    descriptor: ResourceDescriptor::Buffer(descriptor),
                },
                decoded.bytes,
            ));
            result
                .pixels
                .push(PrecompositionMediaPixels { frame, pixels });
            result.receipts.push(decoded.receipt);
        }
        for (request, bytes) in staged {
            registry.put(request, bytes)?;
        }
        Ok(result)
    }
}

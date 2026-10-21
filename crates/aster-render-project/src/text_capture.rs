use crate::{PreparedProjectFrame, ProjectRenderError};
use aster_eval::NativeBundle;
use aster_render_ir::{DecodeLimits, PlanSlice, PrecompositionMediaPixels, ResourceDescriptor};
use aster_renderer::NativeRenderer;

/// Diagnostic pixels are added to the root envelope; executable scene resources are unchanged.
pub struct CapturedProjectText {
    pub bundle: NativeBundle,
    pub pixels: Vec<PrecompositionMediaPixels>,
}

impl PreparedProjectFrame {
    /// Read resident glyph outputs for external replay without exporting native recipe authority.
    /// The caller must render this prepared frame before capturing it.
    pub fn capture_text(
        &self,
        renderer: &NativeRenderer,
        byte_budget: u64,
    ) -> Result<CapturedProjectText, ProjectRenderError> {
        let mut captured = CapturedProjectText {
            bundle: NativeBundle {
                plan: self.bundle.plan.clone(),
                resources: self.bundle.resources.clone(),
            },
            pixels: Vec::new(),
        };
        let plan = &mut captured.bundle.plan;
        let Some(PlanSlice::FrameBundle(envelope)) = plan.metadata.slices.first_mut() else {
            return Err(ProjectRenderError::Invalid(
                "capture frame envelope absent".into(),
            ));
        };
        let mut remaining = byte_budget;
        for input in &self.native_text {
            let resource = renderer.capture_native_glyph(input, remaining)?;
            remaining = remaining
                .checked_sub(resource.bytes().len() as u64)
                .ok_or_else(|| {
                    ProjectRenderError::Invalid("text capture budget exceeded".into())
                })?;
            let ResourceDescriptor::RasterPixels(descriptor) = &resource.request().descriptor
            else {
                return Err(ProjectRenderError::Invalid("capture pixels absent".into()));
            };
            if envelope
                .media_pixels
                .iter()
                .any(|p| p.frame == descriptor.frame)
            {
                return Err(ProjectRenderError::Invalid(
                    "capture text frame already has pixels".into(),
                ));
            }
            let link = PrecompositionMediaPixels {
                frame: descriptor.frame.clone(),
                pixels: resource.request().hash.clone(),
            };
            captured.pixels.push(link.clone());
            envelope.media_pixels.push(link);
            plan.metadata
                .resources
                .push(resource.request().hash.clone());
            captured.bundle.resources.push(resource);
        }
        if !captured.pixels.is_empty() {
            plan.metadata.resources.sort();
            plan.metadata.resources.dedup();
            let counts = plan
                .blobs
                .get_mut(envelope.blob_index as usize)
                .filter(|bytes| bytes.len() == 24)
                .ok_or_else(|| {
                    ProjectRenderError::Invalid("capture envelope counts absent".into())
                })?;
            counts[16..20].copy_from_slice(&(envelope.media_pixels.len() as u32).to_le_bytes());
        }
        plan.encode(&DecodeLimits::default())?;
        Ok(captured)
    }
}

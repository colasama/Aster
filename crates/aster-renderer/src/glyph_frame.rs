use std::{collections::BTreeMap, sync::Arc};

use aster_render_ir::{
    MediaSample, MediaTextureFormat, RasterOrigin, ResourceDescriptor, ResourceHash,
    ResourceRegistry,
};
use aster_text::GlyphGeneration;

use crate::{
    GlyphTextAtlas, GlyphTextConfig, GlyphTextPlan, RenderError,
    image_input::{ImageFormat, ImageInput},
};

/// Native-only recipe. External frame bundles cannot replace pixel payloads with this input.
/// Coordinates, pixels and ordered styles are validated and hashed before frame admission.
#[derive(Clone)]
pub struct NativeGlyphInput {
    pub(crate) frame: ResourceHash,
    pub(crate) atlas: Arc<GlyphGeneration>,
    pub(crate) atlas_identity: ResourceHash,
    pub(crate) generation: ResourceHash,
    pub(crate) plan: GlyphTextPlan,
    pub(crate) config: GlyphTextConfig,
    pub(crate) atlas_bytes: u64,
    pub(crate) output_bytes: u64,
}

impl NativeGlyphInput {
    pub fn new(
        frame: ResourceHash,
        atlas: Arc<GlyphGeneration>,
        plan: GlyphTextPlan,
        config: GlyphTextConfig,
        byte_budget: u64,
    ) -> Result<Self, RenderError> {
        let (atlas_identity, atlas_bytes) =
            GlyphTextAtlas::validate(&atlas, &config, 4096, byte_budget)?;
        let generation = plan.validate(
            (&atlas_identity, atlas.placements.len(), &config),
            (u32::MAX, u64::MAX),
            byte_budget - atlas_bytes,
        )?;
        let output_bytes = plan.required_bytes()?;
        Ok(Self {
            frame,
            atlas,
            atlas_identity,
            generation,
            plan,
            config,
            atlas_bytes,
            output_bytes,
        })
    }

    pub(crate) fn validate_device(&self, limits: &wgpu::Limits) -> Result<(), RenderError> {
        if self
            .atlas
            .pages
            .iter()
            .any(|p| p.dimension > limits.max_texture_dimension_2d)
        {
            return Err(RenderError::Invalid(
                "native glyph atlas exceeds device dimensions".into(),
            ));
        }
        self.plan.validate(
            (
                &self.atlas_identity,
                self.atlas.placements.len(),
                &self.config,
            ),
            (limits.max_texture_dimension_2d, limits.max_buffer_size),
            self.output_bytes,
        )?;
        Ok(())
    }
}

#[derive(Default)]
pub(crate) struct GlyphFrame {
    pub inputs: BTreeMap<ResourceHash, NativeGlyphInput>,
    pub images: BTreeMap<ResourceHash, ImageInput>,
    pub bytes: u64,
}

impl GlyphFrame {
    pub fn collect(
        inputs: Vec<NativeGlyphInput>,
        registry: &ResourceRegistry,
    ) -> Result<Self, RenderError> {
        let mut result = Self::default();
        let mut atlases = BTreeMap::new();
        let mut outputs = BTreeMap::new();
        for input in inputs {
            let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(&input.frame)? else {
                return Err(RenderError::Invalid(
                    "native glyph frame descriptor missing".into(),
                ));
            };
            if !matches!(&frame.sample, MediaSample::Raster(sample) if sample.origin == RasterOrigin::Text)
                || frame.width != input.plan.size.width
                || frame.height != input.plan.size.height
                || frame.format != MediaTextureFormat::Rgba8UnormSrgb
            {
                return Err(RenderError::Invalid(
                    "native glyph frame origin, extent or format differs".into(),
                ));
            }
            atlases.insert(input.atlas_identity.clone(), input.atlas_bytes);
            outputs.insert(input.generation.clone(), input.output_bytes);
            result.images.insert(
                input.frame.clone(),
                ImageInput {
                    frame: input.frame.clone(),
                    pixels: input.generation.clone(),
                    width: frame.width,
                    height: frame.height,
                    format: ImageFormat::Srgb8,
                },
            );
            if result.inputs.insert(input.frame.clone(), input).is_some() {
                return Err(RenderError::Invalid("duplicate native glyph frame".into()));
            }
        }
        result.bytes = atlases
            .values()
            .chain(outputs.values())
            .try_fold(0u64, |total, n| total.checked_add(*n))
            .ok_or_else(|| RenderError::Invalid("native glyph frame byte overflow".into()))?;
        Ok(result)
    }
}

use std::collections::{BTreeMap, BTreeSet};

use aster_render_ir::{
    DecodeLimits, FplnCodec, FrameHeaderSlice, MediaSample, RasterOrigin, ResourceDescriptor,
    ResourceHash, ResourceRegistry,
};

use crate::{RenderError, TemporalTextPlan, image_input::ImageInput, layer_key::LayerKey};

pub(crate) struct TemporalInput {
    pub plan: TemporalTextPlan,
    pub generation: ResourceHash,
}

#[derive(Default)]
pub(crate) struct TemporalFrame {
    pub passes: BTreeMap<ResourceHash, TemporalInput>,
    pub resources: BTreeSet<ResourceHash>,
}

impl TemporalFrame {
    pub fn collect(
        hashes: &[ResourceHash],
        header: &FrameHeaderSlice,
        images: &BTreeMap<ResourceHash, ImageInput>,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<Self, RenderError> {
        let mut result = Self::default();
        for hash in hashes {
            let stage = FplnCodec::decode(registry.resolve(hash)?.to_vec(), limits)?;
            if &stage.metadata.header != header {
                return Err(RenderError::Invalid(
                    "temporal frame identity differs".into(),
                ));
            }
            let plan = TemporalTextPlan::new(&stage)?;
            let mut bytes = b"native-temporal-output-v1".to_vec();
            bytes.extend(hash.0.as_bytes());
            for key in std::iter::once(&plan.output).chain(plan.samples.iter().map(|(h, _)| h)) {
                let input = images.get(key).ok_or_else(|| {
                    RenderError::Invalid("temporal pixel generation absent".into())
                })?;
                let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(key)? else {
                    return Err(RenderError::Invalid(
                        "temporal frame descriptor absent".into(),
                    ));
                };
                if !matches!(&frame.sample, MediaSample::Raster(sample) if sample.origin == RasterOrigin::Text)
                    || frame.width != plan.size.width
                    || frame.height != plan.size.height
                    || frame.format != aster_render_ir::MediaTextureFormat::Rgba8UnormSrgb
                {
                    return Err(RenderError::Invalid(
                        "temporal raster origin, extent or format differs".into(),
                    ));
                }
                result.resources.insert(key.clone());
                if key != &plan.output {
                    bytes.extend(input.pixels.0.as_bytes());
                }
            }
            let generation = LayerKey::hash(&bytes)?;
            if result
                .passes
                .insert(plan.output.clone(), TemporalInput { plan, generation })
                .is_some()
            {
                return Err(RenderError::Invalid("duplicate temporal output".into()));
            }
        }
        for input in result.passes.values() {
            if input
                .plan
                .samples
                .iter()
                .any(|(hash, _)| result.passes.contains_key(hash))
            {
                return Err(RenderError::Invalid(
                    "temporal samples alias derived outputs".into(),
                ));
            }
        }
        Ok(result)
    }

    pub fn required_bytes(&self) -> u64 {
        self.passes
            .values()
            .map(|input| input.plan.required_bytes())
            .sum()
    }

    pub fn resolve_generations(&self, images: &mut BTreeMap<ResourceHash, ImageInput>) {
        for (hash, image) in images {
            if let Some(input) = self.passes.get(hash) {
                image.pixels = input.generation.clone();
            }
        }
    }
}

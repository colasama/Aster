use std::collections::BTreeMap;

use aster_render_ir::{
    ContractLevel, DecodeLimits, EffectBlendMode, EffectComposite, EffectExecutionRoute,
    EffectRoute, FplnCodec, FrameBundleSlice, OwnedFpln, PlanSlice, PrecompositionEffectRecord,
    ResourceRegistry,
};

use crate::RenderError;

pub(crate) struct LayerPlan {
    pub blend: u8,
    pub uniforms: Vec<u8>,
}

impl LayerPlan {
    pub(crate) fn collect(
        bundle: &FrameBundleSlice,
        root: &OwnedFpln,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<BTreeMap<u32, Self>, RenderError> {
        let mut layers = BTreeMap::new();
        for record in &bundle.effects {
            let (instance_id, plan_hash, execution_hash) = match record {
                PrecompositionEffectRecord::Direct { .. } => continue,
                PrecompositionEffectRecord::Ready {
                    instance_id,
                    plan,
                    execution,
                    ..
                } => (instance_id, plan, execution),
                _ => {
                    return Err(RenderError::Unsupported(
                        "skipped or failed layer effect".into(),
                    ));
                }
            };
            let plan = FplnCodec::decode(registry.resolve(plan_hash)?.to_vec(), limits)?;
            let execution = FplnCodec::decode(registry.resolve(execution_hash)?.to_vec(), limits)?;
            if plan.metadata.contract_level != ContractLevel::LayerEffectsSliceV1
                || execution.metadata.contract_level != ContractLevel::EffectExecutionSliceV1
                || plan.metadata.header != root.metadata.header
                || execution.metadata.header != root.metadata.header
            {
                return Err(RenderError::Invalid(
                    "layer identity or contract differs".into(),
                ));
            }
            let Some(PlanSlice::LayerEffect(effect)) = plan.metadata.slices.first() else {
                return Err(RenderError::Invalid("layer program missing".into()));
            };
            let Some(PlanSlice::EffectExecution(route)) = execution.metadata.slices.first() else {
                return Err(RenderError::Invalid("layer route missing".into()));
            };
            if effect.operation_count != 0
                || effect.uses_blur
                || effect.uses_glow
                || effect.route != EffectRoute::Layer
                || route.route != EffectExecutionRoute::Layer
                || route.composite != EffectComposite::Backdrop
            {
                return Err(RenderError::Unsupported(
                    "effect program, pyramid or non-backdrop layer".into(),
                ));
            }
            if effect.instance_id != *instance_id
                || route.instance_id != *instance_id
                || effect.blend_mode != route.blend_mode
            {
                return Err(RenderError::Invalid(
                    "layer program and route disagree".into(),
                ));
            }
            let original = root
                .metadata
                .slices
                .iter()
                .find_map(|slice| match slice {
                    PlanSlice::EffectExecution(value) if value.instance_id == *instance_id => {
                        Some(value)
                    }
                    _ => None,
                })
                .ok_or_else(|| RenderError::Invalid("root layer route missing".into()))?;
            let mut normalized = original.clone();
            normalized.blob_index = route.blob_index;
            if normalized != *route
                || root.blob(original.blob_index as usize)?
                    != execution.blob(route.blob_index as usize)?
            {
                return Err(RenderError::Invalid(
                    "root layer route differs from supplied program".into(),
                ));
            }
            let uniforms = plan.blob(effect.blob_index as usize)?[..96].to_vec();
            // Base parameters may remain supplied; only pyramid-dependent base effects need rejection.
            for lane in [8_usize, 10] {
                let value = &uniforms[lane * 4..lane * 4 + 4];
                if f32::from_le_bytes([value[0], value[1], value[2], value[3]]) != 0.0 {
                    return Err(RenderError::Unsupported("base blur or glow".into()));
                }
            }
            let blend = match effect.blend_mode {
                EffectBlendMode::Multiply => 2,
                EffectBlendMode::Overlay => 4,
                EffectBlendMode::Darken => 5,
                EffectBlendMode::Lighten => 6,
                EffectBlendMode::ColorBurn => 7,
                EffectBlendMode::ColorDodge => 8,
                EffectBlendMode::SoftLight => 9,
                EffectBlendMode::HardLight => 10,
                EffectBlendMode::Difference => 11,
                EffectBlendMode::Exclusion => 12,
                _ => return Err(RenderError::Invalid("backdrop blend required".into())),
            };
            if layers
                .insert(original.blob_index, Self { blend, uniforms })
                .is_some()
            {
                return Err(RenderError::Invalid("duplicate layer execution".into()));
            }
        }
        Ok(layers)
    }
}

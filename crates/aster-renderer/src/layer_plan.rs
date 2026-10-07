use std::collections::BTreeMap;

use aster_render_ir::{
    ContractLevel, DecodeLimits, EffectBlendMode, EffectComposite, EffectExecutionRoute,
    EffectRoute, FplnCodec, OwnedFpln, PlanSlice, PrecompositionEffectRecord, ResourceRegistry,
};

use crate::RenderError;

pub(crate) struct LayerPlan {
    pub blend: u8,
    pub lut: Option<aster_render_ir::ResourceHash>,
    pub uniforms: Vec<u8>,
    pub operations: Vec<u8>,
    pub composite: EffectComposite,
    pub pyramids: crate::pyramid_levels::PyramidLevels,
    pub glow_threshold: f32,
}

impl LayerPlan {
    pub(crate) fn collect(
        effects: &[PrecompositionEffectRecord],
        root: &OwnedFpln,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
        nested: bool,
    ) -> Result<BTreeMap<u32, Self>, RenderError> {
        let mut layers = BTreeMap::new();
        for record in effects {
            let (instance_id, plan_hash, execution_hash, lut_hash) = match record {
                PrecompositionEffectRecord::Direct { .. } => continue,
                PrecompositionEffectRecord::Ready {
                    instance_id,
                    plan,
                    execution,
                    lut,
                    ..
                } => (instance_id, plan, execution, lut),
                _ => {
                    return Err(RenderError::Unsupported(
                        "skipped or failed layer effect".into(),
                    ));
                }
            };
            let plan = FplnCodec::decode(registry.resolve(plan_hash)?.to_vec(), limits)?;
            let execution = FplnCodec::decode(registry.resolve(execution_hash)?.to_vec(), limits)?;
            let mut effect_header = root.metadata.header.clone();
            if nested {
                effect_header.snapshot_scope = "precomposition-effects".into();
            }
            if plan.metadata.contract_level != ContractLevel::LayerEffectsSliceV1
                || execution.metadata.contract_level != ContractLevel::EffectExecutionSliceV1
                || plan.metadata.header != effect_header
                || execution.metadata.header != effect_header
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
            let expected_route = match effect.route {
                EffectRoute::Layer => EffectExecutionRoute::Layer,
                EffectRoute::Adjustment => EffectExecutionRoute::Adjustment,
            };
            if route.route != expected_route {
                return Err(RenderError::Invalid(
                    "effect route differs from program".into(),
                ));
            }
            let bytes = plan.blob(effect.blob_index as usize)?;
            let operations = bytes[96..96 + effect.operation_count as usize * 64].to_vec();
            let mut uses_lut = false;
            if effect.lut_hash != *lut_hash {
                return Err(RenderError::Invalid("layer LUT binding differs".into()));
            }
            for operation in operations.chunks_exact(64) {
                let code = f32::from_le_bytes(
                    operation[..4]
                        .try_into()
                        .map_err(|_| RenderError::Invalid("operation lane".into()))?,
                );
                // The current shared program defines contiguous integer opcodes 1 through 268.
                // Unknown revisions reject rather than silently producing unchanged pixels.
                uses_lut |= code == 32.0;
                if !code.is_finite() || code.fract() != 0.0 || !(1.0..=268.0).contains(&code) {
                    return Err(RenderError::Unsupported(format!("layer operation {code}")));
                }
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
                EffectBlendMode::Normal => 0,
                EffectBlendMode::Add => 1,
                EffectBlendMode::Screen => 3,
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
            };
            if layers
                .insert(
                    original.blob_index,
                    Self {
                        blend,
                        lut: uses_lut.then(|| lut_hash.clone()),
                        uniforms,
                        pyramids: crate::pyramid_levels::PyramidLevels::for_program(
                            root.metadata.header.render_target,
                            &operations,
                            effect.uses_blur,
                            effect.uses_glow,
                        ),
                        operations,
                        composite: route.composite.clone(),
                        glow_threshold: f64::from_le_bytes(
                            bytes[4192..4200]
                                .try_into()
                                .map_err(|_| RenderError::Invalid("glow threshold".into()))?,
                        ) as f32,
                    },
                )
                .is_some()
            {
                return Err(RenderError::Invalid("duplicate layer execution".into()));
            }
        }
        Ok(layers)
    }
}

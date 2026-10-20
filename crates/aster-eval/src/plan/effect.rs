use super::NativePlan;
use crate::{EffectProgram, EffectTrack, EvaluationError};
use aster_render_ir::{
    CompositionIdentity, ContractLevel, EffectBlendMode, EffectComposite, EffectExecutionRoute,
    EffectExecutionSlice, EffectRoute, ElementType, FrameHeaderSlice, LayerEffectSlice, PlanSlice,
    ResourceHash,
};
use aster_types::editor::{Effect, Layer};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectContext {
    Root,
    Precomposition,
    Isolated,
}

#[derive(Clone, Debug, Serialize)]
pub struct EffectExecutionPlan {
    pub plan: NativePlan,
    pub route: EffectExecutionRoute,
    pub blend_mode: EffectBlendMode,
}

struct FusionGroup {
    fused: bool,
    ids: Vec<String>,
}

impl EffectExecutionPlan {
    pub fn build(
        header: FrameHeaderSlice,
        layer: &Layer,
        instance_id: &str,
        context: EffectContext,
    ) -> Result<Self, EvaluationError> {
        let blend_mode: EffectBlendMode =
            serde_json::from_value(serde_json::Value::String(layer.blend_mode.clone()))
                .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let fixed = matches!(
            blend_mode,
            EffectBlendMode::Normal | EffectBlendMode::Add | EffectBlendMode::Screen
        );
        let enabled = layer.effects.iter().any(|e| e.enabled);
        let isolate = !fixed || enabled;
        let route = if layer.kind == "adjustment" {
            if if matches!(context, EffectContext::Precomposition) {
                isolate
            } else {
                enabled
            } {
                EffectExecutionRoute::Adjustment
            } else {
                EffectExecutionRoute::Skip
            }
        } else if matches!(context, EffectContext::Isolated) || isolate {
            EffectExecutionRoute::Layer
        } else {
            EffectExecutionRoute::Direct
        };
        let composite = match route {
            EffectExecutionRoute::Layer if fixed => EffectComposite::Fixed,
            EffectExecutionRoute::Layer => EffectComposite::Backdrop,
            EffectExecutionRoute::Adjustment => EffectComposite::Replace,
            _ => EffectComposite::None,
        };
        let counts = Self::fusion(&layer.effects)?;
        let plan = NativePlan::single(
            header,
            ContractLevel::EffectExecutionSliceV1,
            PlanSlice::EffectExecution(EffectExecutionSlice {
                blob_index: 0,
                instance_id: CompositionIdentity::Unicode(instance_id.into()),
                layer_id: CompositionIdentity::Unicode(layer.id.clone()),
                route: route.clone(),
                blend_mode: blend_mode.clone(),
                composite,
            }),
            ElementType::U32Le,
            counts.iter().flat_map(|n| n.to_le_bytes()).collect(),
            Vec::new(),
        )?;
        Ok(Self {
            plan,
            route,
            blend_mode,
        })
    }

    fn fusion(effects: &[Effect]) -> Result<[u32; 4], EvaluationError> {
        let mut groups: Vec<FusionGroup> = Vec::new();
        let mut operations = 0;
        for effect in effects.iter().filter(|e| e.enabled) {
            let execution = EffectProgram::execution(&effect.effect_type);
            let cost = 1 + if effect.mask.value().is_some() { 2 } else { 0 };
            let supported = execution.is_some() && operations + cost <= 64;
            if supported {
                operations += cost;
            }
            let fused = supported && execution == Some("fused-pixel");
            let previous = groups.last_mut();
            if let Some(previous) = previous
                && fused
                && previous.fused
                && previous.lut_compatible(effect, effects)
            {
                previous.ids.push(effect.id.clone());
            } else {
                groups.push(FusionGroup {
                    fused,
                    ids: vec![effect.id.clone()],
                });
            }
        }
        let fused_effects = groups
            .iter()
            .filter(|g| g.fused)
            .map(|g| g.ids.len())
            .sum::<usize>();
        let fused_groups = groups.iter().filter(|g| g.fused).count();
        let count = |n| {
            u32::try_from(n).map_err(|_| {
                EvaluationError::InvalidScene("effect fusion count exceeds wire range".into())
            })
        };
        Ok([
            count(fused_effects)?,
            count(fused_groups)?,
            count(groups.len() - fused_groups)?,
            operations,
        ])
    }

    /// Compiles a routed layer against an admitted LUT resource dependency.
    pub fn layer_program(
        &self,
        tracks: &[EffectTrack],
        time: f64,
        pixel_scale: f64,
        mip_level_count: u32,
        lut_hash: ResourceHash,
    ) -> Result<Option<NativePlan>, EvaluationError> {
        if matches!(
            self.route,
            EffectExecutionRoute::Direct | EffectExecutionRoute::Skip
        ) {
            return Ok(None);
        }
        let program = EffectProgram::compile_slices(&[tracks], time, pixel_scale)?;
        self.pack_program(&program, time, mip_level_count, lut_hash)
    }

    pub(crate) fn pack_program(
        &self,
        program: &EffectProgram,
        time: f64,
        mip_level_count: u32,
        lut_hash: ResourceHash,
    ) -> Result<Option<NativePlan>, EvaluationError> {
        let route = match self.route {
            EffectExecutionRoute::Layer => EffectRoute::Layer,
            EffectExecutionRoute::Adjustment => EffectRoute::Adjustment,
            _ => return Ok(None),
        };
        if route == EffectRoute::Adjustment && program.count == 0 {
            return Ok(None);
        }
        let header = self.plan.metadata.header.clone();
        let uniforms = NativePlan::post_uniforms(
            [header.render_target.width, header.render_target.height],
            time,
            program.count,
            true,
            mip_level_count.saturating_sub(1),
            program.uses_glow,
        );
        let mut bytes: Vec<u8> = uniforms
            .iter()
            .chain(&program.data)
            .flat_map(|n| n.to_le_bytes())
            .collect();
        bytes.extend_from_slice(&program.glow_threshold.to_le_bytes());
        let Some(PlanSlice::EffectExecution(execution)) = self.plan.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "missing effect execution".into(),
            ));
        };
        Ok(Some(NativePlan::single(
            header,
            ContractLevel::LayerEffectsSliceV1,
            PlanSlice::LayerEffect(LayerEffectSlice {
                blob_index: 0,
                instance_id: execution.instance_id.clone(),
                blend_mode: self.blend_mode.clone(),
                route,
                operation_count: program.count as u32,
                uses_blur: program.uses_blur,
                uses_glow: program.uses_glow,
                lut_hash: lut_hash.clone(),
            }),
            ElementType::U8,
            bytes,
            vec![lut_hash],
        )?))
    }
}

impl FusionGroup {
    fn lut_compatible(&self, effect: &Effect, effects: &[Effect]) -> bool {
        if effect.effect_type != "lut" {
            return true;
        }
        let incoming = effect
            .resource
            .value()
            .map_or("identity", |r| r.checksum.as_str());
        let mut empty = true;
        for previous in effects
            .iter()
            .filter(|e| e.effect_type == "lut" && self.ids.contains(&e.id))
        {
            empty = false;
            if previous
                .resource
                .value()
                .map_or("identity", |r| r.checksum.as_str())
                == incoming
            {
                return true;
            }
        }
        empty
    }
}

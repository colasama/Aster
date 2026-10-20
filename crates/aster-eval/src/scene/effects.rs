use super::{EvaluatedSceneLayer, SceneProject};
use crate::{BundleEffect, EffectContext, EffectPreparation, EvaluationError, PreparedEffect};
use aster_render_ir::{CompositionIdentity, FrameHeaderSlice};
use std::collections::BTreeMap;

impl SceneProject {
    pub fn plan_effects(
        &self,
        header: FrameHeaderSlice,
        layers: &[EvaluatedSceneLayer],
        context: EffectContext,
        mip_level_count: u32,
    ) -> Result<Vec<BundleEffect>, EvaluationError> {
        let CompositionIdentity::Unicode(composition_id) = &header.composition_id else {
            return Err(EvaluationError::InvalidScene(
                "effect composition identity".into(),
            ));
        };
        let index = self.composition_index(composition_id)?;
        let [width, height] = self.compositions[index].size;
        let pixel_scale = (f64::from(header.render_target.width) / width)
            .min(f64::from(header.render_target.height) / height);
        let mut positions = BTreeMap::new();
        let mut result: Vec<BundleEffect> = Vec::new();
        for entry in layers {
            let source = self.composition_index(&entry.source_composition_id)?;
            let layer_index = *self.compositions[source]
                .layer_indices
                .get(&entry.layer_id)
                .ok_or_else(|| EvaluationError::InvalidScene("effect layer is absent".into()))?;
            let layer = &self.project.compositions[source].layers[layer_index];
            let tracks = &self.compositions[source].layers[layer_index].effects;
            let prepared = PreparedEffect::prepare(
                layer,
                tracks,
                EffectPreparation {
                    header: header.clone(),
                    instance_id: entry.instance_id.clone(),
                    context,
                    time: entry.local_time,
                    pixel_scale,
                    mip_level_count,
                },
            )?;
            let effect = BundleEffect {
                instance_id: CompositionIdentity::Unicode(entry.instance_id.clone()),
                prepared,
            };
            // Map replacement preserves the position of the first insertion.
            if let Some(index) = positions.get(&entry.instance_id) {
                result[*index] = effect;
            } else {
                positions.insert(entry.instance_id.clone(), result.len());
                result.push(effect);
            }
        }
        Ok(result)
    }
}

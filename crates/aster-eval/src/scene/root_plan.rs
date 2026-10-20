use super::{EvaluatedSceneLayer, SceneFramePlans, SceneProject};
use crate::{
    EffectContext, EffectExecutionPlan, EvaluationError, FramePlanRequest, NativePlan,
    RootItemKind, RootSceneInput, RootStackItem,
};
use aster_render_ir::{
    CompositionIdentity, PlanSlice, ResourceHash, RootDrawRecord, RootTextureReference,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Default)]
pub struct RootResourceBindings {
    pub media: BTreeMap<String, Option<ResourceHash>>,
    pub generators: BTreeSet<String>,
    pub materials: BTreeMap<String, NativePlan>,
    pub surfaces: BTreeMap<String, String>,
}

impl SceneProject {
    pub fn plan_root_scene(
        &self,
        request: &FramePlanRequest,
        scene: &SceneFramePlans,
        bindings: &RootResourceBindings,
    ) -> Result<NativePlan, EvaluationError> {
        let layers = self.evaluate(&request.composition_id, request.time)?;
        self.plan_evaluated_root(request, scene, bindings, &layers, EffectContext::Root)
    }

    pub fn plan_evaluated_root(
        &self,
        request: &FramePlanRequest,
        scene: &SceneFramePlans,
        bindings: &RootResourceBindings,
        layers: &[EvaluatedSceneLayer],
        context: EffectContext,
    ) -> Result<NativePlan, EvaluationError> {
        let index = self.composition_index(&request.composition_id)?;
        let composition = &self.project.compositions[index];
        let header = request.header(composition)?;
        if scene.scene.metadata.header != header {
            return Err(EvaluationError::InvalidScene(
                "scene and root frame identities differ".into(),
            ));
        }
        let Some(PlanSlice::SceneBuffers(buffers)) = scene.scene.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "missing scene draw records".into(),
            ));
        };
        let mut by_instance = BTreeMap::new();
        for draw in &buffers.draws {
            if let CompositionIdentity::Unicode(id) = &draw.instance_id {
                by_instance.insert(id, draw);
            }
        }
        let mut draws = Vec::new();
        let mut items = Vec::new();
        let mut effects = BTreeMap::new();
        let mut previous_3d = false;
        for entry in layers.iter().rev() {
            let source = self.composition_index(&entry.source_composition_id)?;
            let layer_index = self.compositions[source].layer_indices[&entry.layer_id];
            let layer = &self.project.compositions[source].layers[layer_index];
            let effect =
                EffectExecutionPlan::build(header.clone(), layer, &entry.instance_id, context)?;
            let kind = if layer.kind == "adjustment" {
                RootItemKind::Adjustment
            } else if layer.kind == "generator" {
                RootItemKind::Generator
            } else if let Some(batch) = by_instance.get(&entry.instance_id) {
                let texture = if layer.kind == "precomposition" {
                    if matches!(context, EffectContext::Precomposition) {
                        bindings.surfaces.get(&entry.instance_id).map_or(
                            RootTextureReference::None,
                            |id| RootTextureReference::Surface {
                                instance_id: CompositionIdentity::Unicode(id.clone()),
                            },
                        )
                    } else {
                        RootTextureReference::Surface {
                            instance_id: batch.instance_id.clone(),
                        }
                    }
                } else if layer.kind == "image"
                    || layer.kind == "video"
                    || bindings.media.contains_key(&entry.instance_id)
                {
                    match bindings.media.get(&entry.instance_id) {
                        Some(Some(hash)) => RootTextureReference::Media { hash: hash.clone() },
                        Some(None) => RootTextureReference::Pending,
                        None => {
                            return Err(EvaluationError::InvalidScene(
                                "media hash is absent from the frame".into(),
                            ));
                        }
                    }
                } else {
                    RootTextureReference::None
                };
                let draw_index = draws.len() as u32;
                draws.push(RootDrawRecord {
                    instance_id: batch.instance_id.clone(),
                    first_vertex: batch.first_vertex,
                    vertex_count: batch.vertex_count,
                    blend_mode: if matches!(context, EffectContext::Precomposition) {
                        aster_render_ir::EffectBlendMode::Normal
                    } else {
                        effect.blend_mode.clone()
                    },
                    texture,
                    material_blob_index: None,
                });
                RootItemKind::Geometry(draw_index)
            } else {
                continue;
            };
            let is_3d = layer.three_dimensional || layer.kind == "mesh";
            items.push(RootStackItem {
                instance_id: entry.instance_id.clone(),
                kind,
                clear_depth: previous_3d && !is_3d,
            });
            previous_3d = is_3d;
            effects.insert(entry.instance_id.clone(), effect);
        }
        let mut background = [0.0; 4];
        for (out, number) in background.iter_mut().zip(&composition.background) {
            *out = number.as_f64().filter(|n| n.is_finite()).ok_or_else(|| {
                EvaluationError::InvalidScene("invalid composition background".into())
            })?;
        }
        RootSceneInput {
            header,
            background,
            draws,
            items,
            effects,
            generators: bindings.generators.clone(),
            materials: bindings.materials.clone(),
        }
        .build()
    }
}

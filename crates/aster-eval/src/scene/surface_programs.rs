use super::{
    PrecompositionSources, RootResourceBindings, SceneProject, SurfacePreparation,
    TextGeometryBounds,
};
use crate::{
    EffectContext, EvaluationError, GeneratorCatalog, GeneratorDeviceLimits,
    GeneratorFrameSettings, NativePlan, SurfaceBundleScene,
};
use aster_render_ir::{
    CompositionIdentity, FrameHeaderSlice, MediaDrawBinding, PlanSlice, RootTextureReference,
    SceneMediaBinding,
};
use std::collections::BTreeMap;

pub struct SurfaceProgramInputs {
    pub bindings: RootResourceBindings,
    pub text_bounds: BTreeMap<String, TextGeometryBounds>,
    pub generator_device: GeneratorDeviceLimits,
    pub audio: Option<Vec<u32>>,
}
pub struct SurfaceProgramFrames {
    pub graph: NativePlan,
    pub scenes: Vec<SurfaceBundleScene>,
}
impl SceneProject {
    pub fn plan_surface_programs(
        &self,
        header: FrameHeaderSlice,
        sources: &PrecompositionSources,
        input: &SurfaceProgramInputs,
        catalog: &GeneratorCatalog,
    ) -> Result<SurfaceProgramFrames, EvaluationError> {
        let mut bindings = input.bindings.clone();
        bindings.generators.clear();
        let mut by_target = BTreeMap::new();
        for operation in &sources.operations {
            if let SurfacePreparation::Scene { source } = operation {
                if by_target
                    .insert(source.target.id.as_str(), source)
                    .is_some()
                {
                    return Err(EvaluationError::InvalidScene(
                        "duplicate surface source".into(),
                    ));
                }
                for entry in &source.layers {
                    let index = self.composition_index(&entry.source_composition_id)?;
                    let layer_index = *self.compositions[index]
                        .layer_indices
                        .get(&entry.layer_id)
                        .ok_or_else(|| {
                            EvaluationError::InvalidScene("surface layer is absent".into())
                        })?;
                    if self.project.compositions[index].layers[layer_index].kind == "generator" {
                        bindings.generators.insert(entry.instance_id.clone());
                    }
                }
            }
        }
        let frames = self.plan_surface_frames(header, sources, &input.text_bounds, &bindings)?;
        let mut scenes = Vec::new();
        for frame in frames.frames {
            let source = by_target
                .get(frame.target.id.as_str())
                .ok_or_else(|| EvaluationError::InvalidScene("surface source is absent".into()))?;
            let composition =
                &self.project.compositions[self.composition_index(&source.composition_id)?];
            let mut effect_header = frame.scene.scene.metadata.header.clone();
            effect_header.snapshot_scope = "precomposition-effects".into();
            let mip_level_count = if frame.target.has_effects {
                frame
                    .target
                    .width
                    .div_ceil(2)
                    .max(frame.target.height.div_ceil(2))
                    .ilog2()
                    .saturating_add(1)
                    .min(8)
            } else {
                1
            };
            let effects = self.plan_effects(
                effect_header,
                &source.layers,
                EffectContext::Precomposition,
                mip_level_count,
            )?;
            let mut generator_header = frame.scene.scene.metadata.header.clone();
            generator_header.snapshot_scope = "precomposition-generators".into();
            let generators = self.plan_generators(
                generator_header,
                &source.layers,
                catalog,
                &GeneratorFrameSettings {
                    device: input.generator_device.clone(),
                    camera: self.camera(&source.composition_id, source.time)?,
                    audio: input.audio.clone(),
                },
            )?;
            let Some(PlanSlice::RootSceneCommands(commands)) = frame.root.metadata.slices.first()
            else {
                return Err(EvaluationError::InvalidScene(
                    "surface commands are absent".into(),
                ));
            };
            let mut media = Vec::new();
            for (draw_index, draw) in frame.draw_scene_indices.iter().zip(&commands.draws) {
                let binding = match &draw.texture {
                    RootTextureReference::Media { hash } => {
                        Some(MediaDrawBinding::Frame { hash: hash.clone() })
                    }
                    RootTextureReference::Pending => Some(MediaDrawBinding::Pending),
                    _ => None,
                };
                if let Some(binding) = binding {
                    media.push(SceneMediaBinding {
                        draw_index: *draw_index,
                        binding,
                    });
                }
            }
            media.sort_by_key(|b| b.draw_index);
            scenes.push(SurfaceBundleScene {
                target_id: CompositionIdentity::Unicode(frame.target.id),
                scene: frame.scene.with_media(media)?.scene,
                commands: frame.root,
                draw_scene_indices: frame.draw_scene_indices,
                label_utf16: composition.name.encode_utf16().collect(),
                effects,
                generators,
            });
        }
        Ok(SurfaceProgramFrames {
            graph: frames.graph,
            scenes,
        })
    }
}

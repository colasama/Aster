mod output;
mod resources;
use crate::{EvaluationError, NativePlan, PreparedEffect};
use aster_render_ir::{
    CompositionIdentity, ContractLevel, ElementType, FrameBundleSlice, PlanSlice,
    PrecompositionBundleSlice, PrecompositionGeneratorExecution, PrecompositionGeneratorRecord,
    PrecompositionSceneRecord, VerifiedResource,
};
pub use output::FrameOutputPlans;
pub use resources::{BundleLimits, BundleResources};

pub struct NativeBundle {
    pub plan: NativePlan,
    pub resources: Vec<VerifiedResource>,
}
pub struct BundleMediaPixels {
    pub frame: aster_render_ir::ResourceHash,
    pub pixels: VerifiedResource,
}
pub struct BundleEffect {
    pub instance_id: CompositionIdentity,
    pub prepared: PreparedEffect,
}
pub struct BundleGenerator {
    pub instance_id: CompositionIdentity,
    pub plan: NativePlan,
    pub shaders: Vec<VerifiedResource>,
    pub layer_name_utf16: Vec<u16>,
    pub plugin_id_utf16: Vec<u16>,
    pub execution: PrecompositionGeneratorExecution,
}
pub struct SurfaceBundleScene {
    pub target_id: CompositionIdentity,
    pub scene: NativePlan,
    pub commands: NativePlan,
    pub draw_scene_indices: Vec<u32>,
    pub label_utf16: Vec<u16>,
    pub effects: Vec<BundleEffect>,
    pub generators: Vec<BundleGenerator>,
}
pub struct FrameBundleInput {
    pub scene: NativePlan,
    pub root: NativePlan,
    pub post: NativePlan,
    pub output: FrameOutputPlans,
    pub shadow_map_size: u32,
    pub effects: Vec<BundleEffect>,
    pub generators: Vec<BundleGenerator>,
    pub resources: Vec<VerifiedResource>,
    pub precompositions: Option<NativeBundle>,
    pub temporal: Vec<NativePlan>,
    pub media_pixels: Vec<BundleMediaPixels>,
}
impl BundleGenerator {
    fn record(
        &self,
        resources: &mut BundleResources,
        root: bool,
    ) -> Result<PrecompositionGeneratorRecord, EvaluationError> {
        for shader in &self.shaders {
            resources.add(shader.clone())?;
        }
        Ok(PrecompositionGeneratorRecord {
            instance_id: self.instance_id.clone(),
            plan: resources.add_plan(&self.plan, ContractLevel::SceneGeneratorSliceV1)?,
            layer_name_utf16: if root {
                Vec::new()
            } else {
                self.layer_name_utf16.clone()
            },
            plugin_id_utf16: if root {
                Vec::new()
            } else {
                self.plugin_id_utf16.clone()
            },
            execution: self.execution.clone(),
        })
    }
}
impl SurfaceBundleScene {
    fn validate(&self) -> Result<(), EvaluationError> {
        let Some(PlanSlice::SceneBuffers(scene)) = self.scene.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "missing surface scene geometry".into(),
            ));
        };
        let Some(PlanSlice::RootSceneCommands(commands)) = self.commands.metadata.slices.first()
        else {
            return Err(EvaluationError::InvalidScene(
                "missing surface commands".into(),
            ));
        };
        if self.scene.metadata.header != self.commands.metadata.header
            || self.draw_scene_indices.len() != commands.draws.len()
        {
            return Err(EvaluationError::InvalidScene(
                "surface scene identity or draw mapping differs".into(),
            ));
        }
        for (index, draw) in self.draw_scene_indices.iter().zip(&commands.draws) {
            let source = scene.draws.get(*index as usize).ok_or_else(|| {
                EvaluationError::InvalidScene("surface draw geometry is absent".into())
            })?;
            if draw.instance_id != source.instance_id
                || draw.first_vertex != source.first_vertex
                || draw.vertex_count != source.vertex_count
            {
                return Err(EvaluationError::InvalidScene(
                    "surface draw mapping differs from geometry".into(),
                ));
            }
        }
        Ok(())
    }
}
impl NativeBundle {
    pub fn frame(input: FrameBundleInput, limits: BundleLimits) -> Result<Self, EvaluationError> {
        let header = input.output.validate()?;
        for plan in [&input.scene, &input.root, &input.post] {
            if plan.metadata.header != header {
                return Err(EvaluationError::InvalidScene(
                    "root frame headers differ".into(),
                ));
            }
        }
        let mut resources = BundleResources::new(limits)?;
        for resource in input
            .resources
            .iter()
            .chain(input.precompositions.iter().flat_map(|b| &b.resources))
        {
            resources.add(resource.clone())?;
        }
        let mut slice = FrameBundleSlice {
            blob_index: 0,
            scene: resources.add_plan(&input.scene, ContractLevel::SceneBuffersSliceV1)?,
            root: resources.add_plan(&input.root, ContractLevel::RootSceneCommandsSliceV1)?,
            post: resources.add_plan(&input.post, ContractLevel::PostUniformsSliceV1)?,
            motion: resources.add_plan(
                &input.output.motion,
                ContractLevel::MotionReconstructionSliceV1,
            )?,
            output: resources.add_plan(&input.output.output, ContractLevel::FinalOutputSliceV1)?,
            auxiliary: input
                .output
                .auxiliary
                .as_ref()
                .map(|p| resources.add_plan(p, ContractLevel::AuxiliarySliceV1))
                .transpose()?,
            effect: input
                .output
                .effect
                .as_ref()
                .map(|p| resources.add_plan(p, ContractLevel::PostEffectSliceV1))
                .transpose()?,
            precompositions: input
                .precompositions
                .as_ref()
                .map(|p| resources.add_plan(&p.plan, ContractLevel::PrecompositionBundleSliceV1))
                .transpose()?,
            shadow_map_size: input.shadow_map_size,
            effects: Vec::new(),
            generators: Vec::new(),
            media_pixels: Vec::new(),
            temporal: Vec::new(),
        };
        for temporal in &input.temporal {
            slice
                .temporal
                .push(resources.add_plan(temporal, ContractLevel::TemporalTextPassesSliceV1)?);
        }
        for effect in &input.effects {
            slice.effects.push(
                effect
                    .prepared
                    .record(effect.instance_id.clone(), &mut resources)?,
            );
        }
        for generator in &input.generators {
            slice
                .generators
                .push(generator.record(&mut resources, true)?);
        }
        for pixels in input.media_pixels {
            slice
                .media_pixels
                .push(resources.add_media_pixels(&pixels.frame, pixels.pixels)?);
        }
        slice.media_pixels.sort_by(|a, b| a.frame.cmp(&b.frame));
        let counts = [
            slice.shadow_map_size,
            slice.effects.len() as u32,
            slice.generators.len() as u32,
            u32::from(slice.precompositions.is_some()),
            slice.media_pixels.len() as u32,
            slice.temporal.len() as u32,
        ];
        let resources = resources.finish();
        let plan = NativePlan::single(
            header,
            ContractLevel::FrameBundleSliceV1,
            PlanSlice::FrameBundle(slice),
            ElementType::U32Le,
            counts.iter().flat_map(|v| v.to_le_bytes()).collect(),
            resources.iter().map(|r| r.request().hash.clone()).collect(),
        )?;
        Ok(Self { plan, resources })
    }
    pub fn surfaces(
        graph: NativePlan,
        scenes: Vec<SurfaceBundleScene>,
        supplied: Vec<VerifiedResource>,
        pixels: Vec<BundleMediaPixels>,
        limits: BundleLimits,
    ) -> Result<Self, EvaluationError> {
        let mut resources = BundleResources::new(limits)?;
        for resource in supplied {
            resources.add(resource)?;
        }
        let mut slice = PrecompositionBundleSlice {
            blob_index: 0,
            graph: resources.add_plan(&graph, ContractLevel::PrecompositionGraphSliceV1)?,
            scenes: Vec::new(),
            media_pixels: Vec::new(),
        };
        let mut mappings: Vec<u32> = Vec::new();
        for scene in scenes {
            scene.validate()?;
            mappings.extend(&scene.draw_scene_indices);
            let mut effects = Vec::new();
            for effect in scene.effects {
                effects.push(
                    effect
                        .prepared
                        .record(effect.instance_id.clone(), &mut resources)?,
                );
            }
            let mut generators = Vec::new();
            for generator in scene.generators {
                generators.push(generator.record(&mut resources, false)?);
            }
            slice.scenes.push(PrecompositionSceneRecord {
                target_id: scene.target_id,
                label_utf16: scene.label_utf16,
                scene: resources.add_plan(&scene.scene, ContractLevel::SceneBuffersSliceV1)?,
                commands: resources
                    .add_plan(&scene.commands, ContractLevel::RootSceneCommandsSliceV1)?,
                draw_count: scene.draw_scene_indices.len() as u32,
                effects,
                generators,
            });
        }
        for pixels in pixels {
            slice
                .media_pixels
                .push(resources.add_media_pixels(&pixels.frame, pixels.pixels)?);
        }
        let mut counts = vec![
            slice.scenes.len() as u32,
            mappings.len() as u32,
            slice.scenes.iter().map(|s| s.effects.len() as u32).sum(),
            slice.scenes.iter().map(|s| s.generators.len() as u32).sum(),
        ];
        counts.extend(mappings);
        let resources = resources.finish();
        let plan = NativePlan::single(
            graph.metadata.header,
            ContractLevel::PrecompositionBundleSliceV1,
            PlanSlice::PrecompositionBundle(slice),
            ElementType::U32Le,
            counts.iter().flat_map(|v| v.to_le_bytes()).collect(),
            resources.iter().map(|r| r.request().hash.clone()).collect(),
        )?;
        Ok(Self { plan, resources })
    }
}

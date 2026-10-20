use super::{
    FrameOutputContext, FrameSceneInputs, MaterialResources, RootResourceBindings, SceneFramePlans,
    SceneProject, SurfaceLimits, SurfaceProgramInputs, SurfaceRequest,
};
use crate::{
    BufferVisualization, BundleGenerator, BundleLimits, BundleMediaPixels, DepthSettings,
    EffectContext, EvaluationError, FrameBundleInput, FramePlanRequest, GeneratorCatalog,
    GeneratorDeviceLimits, GeneratorFrameSettings, NativeBundle, TemporalRasterPass,
};
use aster_render_ir::{
    CompositionIdentity, MediaDrawBinding, PlanSlice, PrecompositionGeneratorExecution,
    ResourceHash, RootTextureReference, SceneMediaBinding, VerifiedResource,
};
use std::collections::{BTreeMap, BTreeSet};

/// Immutable resource inputs and observed device allocations for one project frame.
pub struct ProjectFrameResources {
    pub media: BTreeMap<String, Option<ResourceHash>>,
    pub materials: Option<MaterialResources>,
    pub packets: Vec<VerifiedResource>,
    pub pixels: Vec<BundleMediaPixels>,
    pub temporal: Vec<TemporalRasterPass>,
    pub audio: Option<Vec<u32>>,
    pub generator_device: GeneratorDeviceLimits,
    pub surface_request: SurfaceRequest,
    pub surface_limits: SurfaceLimits,
    pub output: FrameOutputContext,
    pub effect_mip_levels: u32,
    pub shadow_map_size: u32,
}

/// Observes allocations while native evaluation still owns the unpublished frame.
pub trait ProjectFrameAllocator {
    fn generator(
        &mut self,
        generator: &BundleGenerator,
    ) -> Result<PrecompositionGeneratorExecution, EvaluationError>;

    fn output(
        &mut self,
        scene: &SceneFramePlans,
        context: FrameOutputContext,
    ) -> Result<FrameOutputContext, EvaluationError>;
}

struct SuppliedOutputAllocation<F> {
    generator: F,
}

impl<F> ProjectFrameAllocator for SuppliedOutputAllocation<F>
where
    F: FnMut(&BundleGenerator) -> Result<PrecompositionGeneratorExecution, EvaluationError>,
{
    fn generator(
        &mut self,
        generator: &BundleGenerator,
    ) -> Result<PrecompositionGeneratorExecution, EvaluationError> {
        (self.generator)(generator)
    }

    fn output(
        &mut self,
        _scene: &SceneFramePlans,
        context: FrameOutputContext,
    ) -> Result<FrameOutputContext, EvaluationError> {
        // Component callers already provide independently observed output allocations.
        Ok(context)
    }
}

impl BundleGenerator {
    /// A realization callback observes this exact invocation, never a cached instance name alone.
    pub fn observe_execution(
        &mut self,
        outcome: PrecompositionGeneratorExecution,
    ) -> Result<bool, EvaluationError> {
        let Some(PlanSlice::SceneGenerator(invocation)) = self.plan.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "generator invocation is absent".into(),
            ));
        };
        let ready = match &outcome {
            PrecompositionGeneratorExecution::Ready {
                capacity,
                effective_count,
            } if *capacity == invocation.capacity
                && *effective_count == invocation.effective_count =>
            {
                true
            }
            PrecompositionGeneratorExecution::Unavailable => false,
            _ => {
                return Err(EvaluationError::InvalidScene(
                    "generator realization does not match invocation".into(),
                ));
            }
        };
        self.execution = outcome;
        Ok(ready)
    }
}

impl SceneProject {
    /// All source evaluation is native; resource acquisition and GPU allocation remain explicit.
    pub fn plan_project_frame(
        &self,
        request: &FramePlanRequest,
        scene_input: &FrameSceneInputs,
        input: ProjectFrameResources,
        catalog: &GeneratorCatalog,
        limits: BundleLimits,
        realize: impl FnMut(
            &BundleGenerator,
        ) -> Result<PrecompositionGeneratorExecution, EvaluationError>,
    ) -> Result<NativeBundle, EvaluationError> {
        self.plan_project_frame_allocated(
            request,
            scene_input,
            input,
            catalog,
            limits,
            SuppliedOutputAllocation { generator: realize },
        )
    }

    pub fn plan_project_frame_allocated(
        &self,
        request: &FramePlanRequest,
        scene_input: &FrameSceneInputs,
        input: ProjectFrameResources,
        catalog: &GeneratorCatalog,
        limits: BundleLimits,
        mut allocator: impl ProjectFrameAllocator,
    ) -> Result<NativeBundle, EvaluationError> {
        let scale = match request.anti_aliasing {
            aster_render_ir::AntiAliasing::Off | aster_render_ir::AntiAliasing::Fxaa => 1.0,
            aster_render_ir::AntiAliasing::Ssaa2x => 2.0,
            aster_render_ir::AntiAliasing::Ssaa4x => 4.0,
        };
        if input.surface_request.render_scale != scale {
            return Err(EvaluationError::InvalidScene(
                "surface render scale differs from frame".into(),
            ));
        }
        let surface_revision = input.surface_request.revision;
        let current = self.evaluate(&request.composition_id, request.time)?;
        let mut primary_light = None;
        for entry in &current {
            let layer = self.layer(&entry.source_composition_id, &entry.layer_id)?;
            if layer.kind == "light" {
                primary_light = layer.light.value();
                break;
            }
        }
        let mut effective_request = request.clone();
        effective_request.shadows_enabled = input.shadow_map_size > 1
            && primary_light
                .is_none_or(|light| light.shadow_quality != "off" && light.kind != "point");
        let request = &effective_request;
        let mut prepared = self.prepare_evaluated_frame_scene(request, scene_input, current)?;
        let header = prepared.plans.scene.metadata.header.clone();
        let beauty = matches!(scene_input.visualization, BufferVisualization::Beauty);
        let sources = if beauty {
            self.precomposition_sources_with_text(
                &prepared.layers,
                input.surface_request,
                &input.surface_limits,
                &scene_input.text_layouts,
                &scene_input.locale,
            )?
        } else {
            self.precomposition_sources(
                &prepared.layers,
                input.surface_request,
                &input.surface_limits,
            )?
        };
        let mut bindings = RootResourceBindings {
            media: input.media,
            surfaces: sources.bindings.clone(),
            materials: match &input.materials {
                Some(materials) => {
                    self.plan_materials(header.clone(), &prepared.layers, materials)?
                }
                None => BTreeMap::new(),
            },
            generators: BTreeSet::new(),
        };
        let mut surface_header = header.clone();
        surface_header.project_revision = surface_revision;
        let mut surfaces = self.plan_surface_programs(
            surface_header,
            &sources,
            &SurfaceProgramInputs {
                bindings: bindings.clone(),
                text_bounds: scene_input.text_bounds.clone(),
                generator_device: input.generator_device.clone(),
                audio: input.audio.clone(),
            },
            catalog,
        )?;
        let candidates = self.plan_generators(
            header.clone(),
            &prepared.layers,
            catalog,
            &GeneratorFrameSettings {
                device: input.generator_device,
                camera: prepared.camera.clone(),
                audio: input.audio,
            },
        )?;
        let mut generators = Vec::new();
        let mut output_context = input.output;
        output_context.visualization = scene_input.visualization;
        output_context.beauty_depth_of_field = prepared.beauty_depth_of_field;
        output_context.beauty_motion_blur = prepared.beauty_motion_blur;
        output_context.motion_blur_requested = prepared.motion_blur_requested;
        output_context.generator_selection_ids.clear();
        output_context.auxiliary_generators.clear();
        for mut generator in candidates {
            if !generator.observe_execution(allocator.generator(&generator)?)? {
                continue;
            }
            let Some(PlanSlice::SceneGenerator(invocation)) =
                generator.plan.metadata.slices.first()
            else {
                return Err(EvaluationError::InvalidScene(
                    "root generator invocation is absent".into(),
                ));
            };
            let (CompositionIdentity::Unicode(id), CompositionIdentity::Unicode(selection)) =
                (&generator.instance_id, &invocation.selection_id)
            else {
                return Err(EvaluationError::InvalidScene(
                    "native generator identity is invalid".into(),
                ));
            };
            bindings.generators.insert(id.clone());
            output_context
                .generator_selection_ids
                .push(selection.clone());
            if invocation.program.graph.render_variants[invocation.variant_index as usize]
                .auxiliary
                .is_some()
            {
                output_context.auxiliary_generators.push(id.clone());
            }
            generators.push(generator);
        }
        for scene in &mut surfaces.scenes {
            for generator in &mut scene.generators {
                generator.observe_execution(allocator.generator(generator)?)?;
            }
        }
        let precompositions = if let Some(first) = surfaces.scenes.first() {
            // The retained serializer anchors its graph to the first child scene.
            surfaces.graph.metadata.header = first.scene.metadata.header.clone();
            Some(NativeBundle::surfaces(
                surfaces.graph,
                surfaces.scenes,
                input.packets.clone(),
                Vec::new(),
                limits.clone(),
            )?)
        } else {
            None
        };
        let root = self.plan_evaluated_root(
            request,
            &prepared.plans,
            &bindings,
            &prepared.layers,
            EffectContext::Root,
        )?;
        let (Some(PlanSlice::RootSceneCommands(commands)), Some(PlanSlice::SceneBuffers(buffers))) = (
            root.metadata.slices.first(),
            prepared.plans.scene.metadata.slices.first(),
        ) else {
            return Err(EvaluationError::InvalidScene(
                "root geometry mapping is absent".into(),
            ));
        };
        let textures: BTreeMap<_, _> = commands
            .draws
            .iter()
            .filter_map(|d| match &d.instance_id {
                CompositionIdentity::Unicode(id) => Some((id.as_str(), &d.texture)),
                _ => None,
            })
            .collect();
        let media = buffers
            .draws
            .iter()
            .enumerate()
            .filter_map(|(index, draw)| {
                let CompositionIdentity::Unicode(id) = &draw.instance_id else {
                    return None;
                };
                let binding = match textures.get(id.as_str()) {
                    Some(RootTextureReference::Media { hash }) => {
                        MediaDrawBinding::Frame { hash: hash.clone() }
                    }
                    Some(RootTextureReference::Pending) => MediaDrawBinding::Pending,
                    _ => return None,
                };
                Some(SceneMediaBinding {
                    draw_index: index as u32,
                    binding,
                })
            })
            .collect();
        prepared.plans = prepared.plans.with_media(media)?;
        output_context = allocator.output(&prepared.plans, output_context)?;
        if let Some(camera) = &prepared.camera {
            let index = self.composition_index(&request.composition_id)?;
            output_context.depth_settings = DepthSettings::from_camera(
                camera,
                self.compositions[index].size[0],
                f64::from(request.render_target.width),
                f64::from(output_context.auxiliary_budget.tier),
            );
        }
        let output = self.plan_frame_output(
            &prepared.plans,
            &prepared.layers,
            &bindings,
            &output_context,
        )?;
        let effects = self.plan_effects(
            header.clone(),
            &prepared.layers,
            EffectContext::Root,
            input.effect_mip_levels,
        )?;
        let temporal = input
            .temporal
            .into_iter()
            .map(|p| p.plan(header.clone()))
            .collect::<Result<_, _>>()?;
        NativeBundle::frame(
            FrameBundleInput {
                scene: prepared.plans.scene,
                root,
                post: prepared.plans.post,
                output,
                shadow_map_size: input.shadow_map_size,
                effects,
                generators,
                resources: input.packets,
                precompositions,
                temporal,
                media_pixels: input.pixels,
            },
            limits,
        )
    }
}

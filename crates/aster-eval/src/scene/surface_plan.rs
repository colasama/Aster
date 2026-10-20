use super::{
    PrecompositionSources, RootResourceBindings, SceneFramePlans, SceneProject, SurfacePreparation,
    SurfaceSource, SurfaceTarget, TextGeometryBounds,
};
use crate::{EffectContext, EvaluationError, FramePlanRequest, NativePlan};
use aster_render_ir::{
    AntiAliasing, CompositionIdentity, ContractLevel, ElementType, Extent2d, FrameHeaderSlice,
    PlanSlice, PrecompositionBinding, PrecompositionGraphSlice, PrecompositionTargetRecord,
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
pub struct SurfaceFrame {
    pub target: SurfaceTarget,
    pub scene: SceneFramePlans,
    pub root: NativePlan,
    pub draw_scene_indices: Vec<u32>,
    #[serde(skip)]
    routes: Vec<SurfaceRoute>,
}
#[derive(Clone, Debug)]
enum SurfaceRoute {
    None,
    Skipped,
    Target(String),
}
#[derive(Clone, Debug, Serialize)]
pub struct SurfaceFramePlans {
    pub graph: NativePlan,
    pub frames: Vec<SurfaceFrame>,
}

impl SceneProject {
    pub fn plan_surface_frames(
        &self,
        header: FrameHeaderSlice,
        sources: &PrecompositionSources,
        text_bounds: &BTreeMap<String, TextGeometryBounds>,
        bindings: &RootResourceBindings,
    ) -> Result<SurfaceFramePlans, EvaluationError> {
        let mut frames = Vec::new();
        let bindings = RootResourceBindings {
            surfaces: sources.bindings.clone(),
            materials: BTreeMap::new(),
            ..bindings.clone()
        };
        for operation in &sources.operations {
            if let SurfacePreparation::Scene { source } = operation {
                frames.push(self.surface_frame(
                    source,
                    header.project_revision,
                    text_bounds,
                    &bindings,
                )?);
            }
        }
        let graph = SurfaceFramePlans::graph(header, &frames, sources)?;
        Ok(SurfaceFramePlans { graph, frames })
    }

    fn surface_frame(
        &self,
        source: &SurfaceSource,
        revision: u64,
        text_bounds: &BTreeMap<String, TextGeometryBounds>,
        bindings: &RootResourceBindings,
    ) -> Result<SurfaceFrame, EvaluationError> {
        let composition =
            &self.project.compositions[self.composition_index(&source.composition_id)?];
        let width = composition
            .width
            .as_f64()
            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= u32::MAX as f64)
            .map(|n| n as u32)
            .ok_or_else(|| {
                EvaluationError::InvalidScene("surface composition width must be an integer".into())
            })?;
        let height = composition
            .height
            .as_f64()
            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 1.0 && *n <= u32::MAX as f64)
            .map(|n| n as u32)
            .ok_or_else(|| {
                EvaluationError::InvalidScene(
                    "surface composition height must be an integer".into(),
                )
            })?;
        let request = FramePlanRequest {
            snapshot_scope: "precomposition-scenes".into(),
            project_revision: revision,
            composition_id: composition.id.clone(),
            time: source.time,
            target: Extent2d { width, height },
            render_target: Extent2d {
                width: source.target.width,
                height: source.target.height,
            },
            anti_aliasing: AntiAliasing::Off,
            shadows_enabled: false,
        };
        let scene = self.plan_evaluated_scene(&request, &source.layers, text_bounds)?;
        let root = self.plan_evaluated_root(
            &request,
            &scene,
            bindings,
            &source.layers,
            EffectContext::Precomposition,
        )?;
        let Some(PlanSlice::SceneBuffers(buffers)) = scene.scene.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "missing surface geometry".into(),
            ));
        };
        let Some(PlanSlice::RootSceneCommands(commands)) = root.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "missing surface commands".into(),
            ));
        };
        let by_instance: BTreeMap<_, _> = source
            .layers
            .iter()
            .map(|s| (s.instance_id.as_str(), s))
            .collect();
        let mut draw_scene_indices = Vec::new();
        let mut routes = Vec::new();
        for draw in &commands.draws {
            let index = buffers
                .draws
                .iter()
                .rposition(|b| b.instance_id == draw.instance_id)
                .ok_or_else(|| {
                    EvaluationError::InvalidScene("surface draw geometry is absent".into())
                })?;
            draw_scene_indices.push(index as u32);
            let CompositionIdentity::Unicode(id) = &draw.instance_id else {
                return Err(EvaluationError::InvalidScene(
                    "surface draw identity".into(),
                ));
            };
            let entry = by_instance.get(id.as_str()).ok_or_else(|| {
                EvaluationError::InvalidScene("surface draw source is absent".into())
            })?;
            let source_index = self.composition_index(&entry.source_composition_id)?;
            let layer = &self.project.compositions[source_index].layers
                [self.compositions[source_index].layer_indices[&entry.layer_id]];
            routes.push(if layer.kind == "precomposition" {
                bindings
                    .surfaces
                    .get(id)
                    .map_or(SurfaceRoute::Skipped, |target| {
                        SurfaceRoute::Target(target.clone())
                    })
            } else {
                SurfaceRoute::None
            });
        }
        Ok(SurfaceFrame {
            target: source.target.clone(),
            scene,
            root,
            draw_scene_indices,
            routes,
        })
    }
}

impl SurfaceFramePlans {
    fn graph(
        header: FrameHeaderSlice,
        frames: &[SurfaceFrame],
        sources: &PrecompositionSources,
    ) -> Result<NativePlan, EvaluationError> {
        let indices: BTreeMap<_, _> = frames
            .iter()
            .enumerate()
            .map(|(i, f)| (f.target.id.as_str(), i as u32))
            .collect();
        let lookup = |id: &str| {
            indices.get(id).copied().ok_or_else(|| {
                EvaluationError::InvalidScene("surface target absent from graph".into())
            })
        };
        let mut targets = Vec::new();
        let mut bindings = Vec::new();
        let mut routes = Vec::new();
        for frame in frames {
            targets.push(PrecompositionTargetRecord {
                id: CompositionIdentity::Unicode(frame.target.id.clone()),
                width: frame.target.width,
                height: frame.target.height,
                estimated_bytes: frame.target.estimated_bytes,
                texture_count: frame.target.texture_count as u32,
                has_effects: frame.target.has_effects,
                draw_count: frame.routes.len() as u32,
            });
            for route in &frame.routes {
                routes.push(match route {
                    SurfaceRoute::None => 0,
                    SurfaceRoute::Skipped => 1,
                    SurfaceRoute::Target(id) => lookup(id)? + 2,
                });
            }
        }
        for id in &sources.binding_order {
            let target = sources.bindings.get(id).ok_or_else(|| {
                EvaluationError::InvalidScene("surface alias order differs from bindings".into())
            })?;
            bindings.push(PrecompositionBinding {
                instance_id: CompositionIdentity::Unicode(id.clone()),
                target_index: lookup(target)?,
            });
        }
        let bytes = [
            targets.len() as u32,
            routes.len() as u32,
            bindings.len() as u32,
            0,
        ]
        .into_iter()
        .chain(routes)
        .flat_map(u32::to_le_bytes)
        .collect();
        NativePlan::single(
            header,
            ContractLevel::PrecompositionGraphSliceV1,
            PlanSlice::PrecompositionGraph(PrecompositionGraphSlice {
                blob_index: 0,
                targets,
                bindings,
            }),
            ElementType::U32Le,
            bytes,
            Vec::new(),
        )
    }
}

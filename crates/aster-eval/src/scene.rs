mod audio_mix;
mod auxiliary;
pub use audio_mix::{
    AudioComposition, AudioMix, AudioMixLimits, AudioMixRequest, AudioPcm, AudioSourceRequest,
    ClipProtection, CompositionAudioReader,
};
mod effects;
mod generators;
pub use generators::GeneratorFrameSettings;
mod evaluate;
pub use auxiliary::AuxiliaryBudget;
mod material_identity;
mod materials;
pub use material_identity::RenderIdentity;
pub use materials::{MaterialResources, MaterialTextureSources};
mod frame;
mod motion;
pub use frame::{FrameSceneInputs, PreparedSceneFrame};
mod output;
mod project_frame;
pub use output::FrameOutputContext;
pub use project_frame::{ProjectFrameAllocator, ProjectFrameResources};
mod text_exposure;
pub use text_exposure::{
    TextExposureFrame, TextExposurePlan, TextExposureRequest, TextExposureSample, TextLayouts,
};
mod precomposition;
mod surface_budget;
mod surface_plan;
mod surface_programs;
pub use precomposition::{PrecompositionSources, SurfacePreparation, SurfaceSource};
pub use surface_budget::{SurfaceBudget, SurfaceLimits, SurfaceRequest, SurfaceTarget};
pub use surface_plan::{SurfaceFrame, SurfaceFramePlans};
pub use surface_programs::{SurfaceProgramFrames, SurfaceProgramInputs};
mod plan;
mod root_plan;
pub use plan::SceneFramePlans;
pub use root_plan::RootResourceBindings;
mod raster_requests;
mod resource_requests;
pub use resource_requests::{
    ProjectResourceRequests, ResourcePreparationOperation, ResourceRequestContext,
};
mod resources;
pub use raster_requests::{RetainedRasterContext, RetainedRasterKind, RetainedRasterRequest};
mod time;
mod transform;

use crate::{
    EvaluatedTransform, EvaluationError, EvaluationLimits, ExpressionLimits, TransformTrack,
};
use aster_types::editor::{Layer, Project};
pub use resources::{SceneGeometry, SceneGeometryRecord, ShapeGraphEvaluation, TextGeometryBounds};
use serde::Serialize;
use serde_json::Number;
use std::collections::BTreeMap;
pub use time::LayerClock;

#[derive(Clone, Debug, clap::Args)]
pub struct SceneLimits {
    #[command(flatten)]
    pub cloners: crate::ClonerLimits,
    #[command(flatten)]
    pub effects: crate::EffectLimits,
    #[command(flatten)]
    pub text: crate::TextLimits,
    #[command(flatten)]
    pub paths: crate::PathLimits,
    #[command(flatten)]
    pub shape_graphs: crate::ShapeGraphLimits,
    #[command(flatten)]
    pub geometry: crate::GeometryLimits,
    #[arg(long, default_value_t = Self::default().max_compositions)]
    pub max_compositions: usize,
    #[arg(long, default_value_t = Self::default().max_project_layers)]
    pub max_project_layers: usize,
    #[arg(long, default_value_t = Self::default().max_composition_depth)]
    pub max_composition_depth: usize,
}

impl Default for SceneLimits {
    fn default() -> Self {
        Self {
            cloners: crate::ClonerLimits::default(),
            effects: crate::EffectLimits::default(),
            text: crate::TextLimits::default(),
            paths: crate::PathLimits::default(),
            shape_graphs: crate::ShapeGraphLimits::default(),
            geometry: crate::GeometryLimits::default(),
            max_compositions: 4096,
            max_project_layers: 65536,
            max_composition_depth: 128,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluatedSceneLayer {
    pub layer_id: String,
    pub source_composition_id: String,
    pub transform: EvaluatedTransform,
    pub local_time: f64,
    pub instance_id: String,
    pub resource_instance_id: String,
    pub selection_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precomposition_surface: Option<PrecompositionSurface>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecompositionSurface {
    pub composition_id: String,
    pub time: f64,
    pub composition_path: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SceneProject {
    project: Project,
    compositions: Vec<CompiledComposition>,
    composition_indices: BTreeMap<String, usize>,
    limits: SceneLimits,
}

#[derive(Clone, Debug)]
struct CompiledComposition {
    size: [f64; 2],
    duration: f64,
    contains_camera: bool,
    layers: Vec<CompiledLayer>,
    layer_indices: BTreeMap<String, usize>,
}

#[derive(Clone, Debug)]
struct CompiledLayer {
    material_id: u32,
    cloner: Option<crate::ClonerTrack>,
    effects: Vec<crate::EffectTrack>,
    text: Option<crate::TextAnimatorTrack>,
    geometry: Option<crate::LayerGeometry>,
    shape_graph: Option<crate::ShapeGraphTrack>,
    camera: Option<crate::CameraTrack>,
    transform: TransformTrack,
    clock: LayerClock,
    size: [f64; 2],
    parent: Option<usize>,
    nested: Option<usize>,
    surface: bool,
    out_point: f64,
}

impl SceneProject {
    /// Authored text and embedded fonts share the same compiled project revision.
    pub fn text_sources(&self) -> (Vec<&Layer>, &[aster_types::editor::ProjectFont]) {
        let layers = self
            .project
            .compositions
            .iter()
            .flat_map(|c| &c.layers)
            .filter(|layer| layer.kind == "text")
            .collect();
        let fonts = self
            .project
            .fonts
            .value()
            .map(Vec::as_slice)
            .unwrap_or_default();
        (layers, fonts)
    }

    pub fn composition(
        &self,
        id: &str,
    ) -> Result<&aster_types::editor::Composition, EvaluationError> {
        let index = self.composition_index(id)?;
        Ok(&self.project.compositions[index])
    }

    pub fn compile(
        project: Project,
        limits: &SceneLimits,
        evaluation_limits: &EvaluationLimits,
        expression_limits: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        if project.compositions.len() > limits.max_compositions
            || project
                .compositions
                .iter()
                .map(|c| c.layers.len())
                .sum::<usize>()
                > limits.max_project_layers
        {
            return Err(EvaluationError::InvalidScene(
                "project evaluation budget exceeded".into(),
            ));
        }
        let mut composition_indices = BTreeMap::new();
        for (index, composition) in project.compositions.iter().enumerate() {
            composition_indices
                .entry(composition.id.clone())
                .or_insert(index);
        }
        let mut compositions = Vec::with_capacity(project.compositions.len());
        for composition in &project.compositions {
            let size = [
                Self::number(&composition.width)?,
                Self::number(&composition.height)?,
            ];
            let duration = Self::number(&composition.duration)?;
            if size.iter().any(|n| *n <= 0.) || duration < 0. {
                return Err(EvaluationError::InvalidScene(
                    "invalid composition dimensions or duration".into(),
                ));
            }
            let mut layer_indices = BTreeMap::new();
            for (index, layer) in composition.layers.iter().enumerate() {
                layer_indices.entry(layer.id.clone()).or_insert(index);
            }
            let mut layers = Vec::with_capacity(composition.layers.len());
            for layer in &composition.layers {
                if layer.effects.len() > limits.effects.max_layer_effects {
                    return Err(EvaluationError::InvalidScene(
                        "layer effect budget exceeded".into(),
                    ));
                }
                layers.push(CompiledLayer {
                    material_id: RenderIdentity::material(layer)?,
                    cloner: layer
                        .cloner
                        .value()
                        .map(|settings| crate::ClonerTrack::compile(settings, &limits.cloners))
                        .transpose()?,
                    effects: layer
                        .effects
                        .iter()
                        .map(|effect| {
                            crate::EffectTrack::compile(
                                effect,
                                &limits.effects,
                                evaluation_limits,
                                expression_limits,
                            )
                        })
                        .collect::<Result<_, _>>()?,
                    text: layer
                        .text_animator
                        .value()
                        .map(|settings| {
                            crate::TextAnimatorTrack::compile(
                                settings,
                                &limits.text,
                                evaluation_limits,
                                expression_limits,
                            )
                        })
                        .transpose()?,
                    geometry: crate::LayerGeometry::compile(
                        layer,
                        &limits.geometry,
                        &limits.paths,
                        evaluation_limits,
                        expression_limits,
                    )?,
                    shape_graph: layer
                        .shape_graph
                        .value()
                        .map(|graph| {
                            crate::ShapeGraphTrack::compile(
                                graph,
                                &limits.shape_graphs,
                                &limits.paths,
                                evaluation_limits,
                            )
                        })
                        .transpose()?,
                    camera: if layer.kind == "camera" {
                        Some(crate::CameraTrack::compile(
                            layer.camera.value(),
                            size,
                            evaluation_limits,
                        )?)
                    } else {
                        None
                    },
                    transform: TransformTrack::compile_layer(
                        layer,
                        evaluation_limits,
                        expression_limits,
                    )?,
                    clock: LayerClock::compile(layer, evaluation_limits)?,
                    size: [Self::number(&layer.size[0])?, Self::number(&layer.size[1])?],
                    parent: layer
                        .parent_id
                        .value()
                        .and_then(|id| layer_indices.get(id))
                        .copied(),
                    nested: if layer.kind == "precomposition" {
                        layer
                            .source_composition_id
                            .value()
                            .and_then(|id| composition_indices.get(id))
                            .copied()
                    } else {
                        None
                    },
                    surface: layer.three_dimensional || layer.effects.iter().any(|e| e.enabled),
                    out_point: Self::number(&layer.out_point)?,
                });
            }
            compositions.push(CompiledComposition {
                size,
                duration,
                contains_camera: composition.layers.iter().any(|l| l.kind == "camera"),
                layers,
                layer_indices,
            });
        }
        Ok(Self {
            project,
            compositions,
            composition_indices,
            limits: limits.clone(),
        })
    }

    pub fn layer(&self, composition_id: &str, layer_id: &str) -> Result<&Layer, EvaluationError> {
        let index = self.composition_index(composition_id)?;
        let layer_index = self.compositions[index]
            .layer_indices
            .get(layer_id)
            .ok_or_else(|| EvaluationError::InvalidScene("unknown layer".into()))?;
        Ok(&self.project.compositions[index].layers[*layer_index])
    }

    fn composition_index(&self, id: &str) -> Result<usize, EvaluationError> {
        self.composition_indices
            .get(id)
            .copied()
            .ok_or_else(|| EvaluationError::InvalidScene("unknown composition".into()))
    }

    fn number(value: &Number) -> Result<f64, EvaluationError> {
        value
            .as_f64()
            .filter(|n| n.is_finite())
            .ok_or_else(|| EvaluationError::InvalidScene("scene numbers must be finite".into()))
    }
}

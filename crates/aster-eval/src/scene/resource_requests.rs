use super::{
    EvaluatedSceneLayer, RetainedRasterContext, RetainedRasterRequest, SceneProject, SurfaceLimits,
    SurfacePreparation, SurfaceRequest, SurfaceTarget, TextExposurePlan, TextExposureRequest,
    TextLayouts,
};
use crate::{BufferVisualization, EvaluationError, FramePlanRequest};
use aster_render_ir::{AntiAliasing, FrameHeaderSlice};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRequestContext {
    pub visualization: BufferVisualization,
    pub locale: String,
    pub layouts: TextLayouts,
    pub surface: SurfaceRequest,
    pub maximum_raster_dimension: u32,
    pub maximum_raster_pixels: u64,
}

/// Ordered acquisition requests contain native decisions, never host-authored scene plans.
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResourcePreparationOperation {
    Raster {
        request: RetainedRasterRequest,
    },
    Media {
        composition_id: String,
        layer_id: String,
        instance_id: String,
        source_id: Option<String>,
        local_time: f64,
    },
    Target {
        target: SurfaceTarget,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectResourceRequests {
    pub header: FrameHeaderSlice,
    pub operations: Vec<ResourcePreparationOperation>,
    pub surface_bindings: BTreeMap<String, String>,
    pub diagnostics: Vec<String>,
}

impl SceneProject {
    /// Root text is prepared before child surfaces; root file media follows child acquisition.
    /// Device allocation is a later step: a target request does not claim successful allocation.
    pub fn project_resource_requests(
        &self,
        request: &FramePlanRequest,
        context: &ResourceRequestContext,
        limits: &SurfaceLimits,
    ) -> Result<ProjectResourceRequests, EvaluationError> {
        let index = self.composition_index(&request.composition_id)?;
        let header = request.header(&self.project.compositions[index])?;
        if header.project_revision > 9_007_199_254_740_991
            || header.snapshot_scope.is_empty()
            || header.snapshot_scope.len() > 256
            || header.snapshot_scope.contains('\0')
        {
            return Err(EvaluationError::InvalidScene(
                "invalid resource frame identity".into(),
            ));
        }
        let admission = aster_render_ir::DecodeLimits::default();
        header
            .target
            .validate(&admission)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        header
            .render_target
            .validate(&admission)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let scale = match request.anti_aliasing {
            AntiAliasing::Off | AntiAliasing::Fxaa => 1.0,
            AntiAliasing::Ssaa2x => 2.0,
            AntiAliasing::Ssaa4x => 4.0,
        };
        if context.surface.render_scale != scale
            || f64::from(header.render_target.width) != f64::from(header.target.width) * scale
            || f64::from(header.render_target.height) != f64::from(header.target.height) * scale
        {
            return Err(EvaluationError::InvalidScene(
                "surface render scale differs from frame".into(),
            ));
        }
        let raster = RetainedRasterContext {
            resolution_scale: (f64::from(request.render_target.width)
                / self.compositions[index].size[0])
                .max(f64::from(request.render_target.height) / self.compositions[index].size[1]),
            maximum_dimension: context.maximum_raster_dimension,
            maximum_pixels: context.maximum_raster_pixels,
        };
        // Validate raster admission even when the active frame has no retained raster layers.
        self.retained_raster_requests(&request.composition_id, &[], &raster, &BTreeMap::new())?;
        let beauty = matches!(context.visualization, BufferVisualization::Beauty);
        let (scenes, exposure) = if beauty {
            let frame = self.text_exposure_frame(
                &TextExposureRequest {
                    composition_id: request.composition_id.clone(),
                    time: request.time,
                    resolution_scale: raster.resolution_scale,
                    locale: context.locale.clone(),
                },
                &context.layouts,
            )?;
            (frame.render_scene_layers, frame.plans)
        } else {
            (
                self.evaluate(&request.composition_id, request.time)?,
                BTreeMap::new(),
            )
        };
        let mut operations = Vec::new();
        for scene in &scenes {
            if self
                .layer(&scene.source_composition_id, &scene.layer_id)?
                .kind
                == "text"
            {
                operations.extend(self.resource_operations(
                    scene,
                    &request.composition_id,
                    &raster,
                    &exposure,
                )?);
            }
        }
        let sources = if beauty {
            self.precomposition_sources_with_text(
                &scenes,
                context.surface.clone(),
                limits,
                &context.layouts,
                &context.locale,
            )?
        } else {
            self.precomposition_sources(&scenes, context.surface.clone(), limits)?
        };
        for operation in &sources.operations {
            match operation {
                SurfacePreparation::Target { target } => {
                    operations.push(ResourcePreparationOperation::Target {
                        target: target.clone(),
                    })
                }
                SurfacePreparation::Media {
                    scene,
                    resolution_scale,
                    text_motion_blur,
                } => {
                    let text = self
                        .layer(&scene.source_composition_id, &scene.layer_id)?
                        .kind
                        == "text";
                    let child_context = RetainedRasterContext {
                        // The retained child image path uses its default density, independently of text.
                        resolution_scale: if text { *resolution_scale } else { 1.0 },
                        ..raster.clone()
                    };
                    let exposure = text_motion_blur
                        .clone()
                        .map(|plan| (scene.resource_instance_id.clone(), plan))
                        .into_iter()
                        .collect();
                    operations.extend(self.resource_operations(
                        scene,
                        &scene.source_composition_id,
                        &child_context,
                        &exposure,
                    )?);
                }
                SurfacePreparation::Scene { .. } => {}
            }
        }
        for scene in &scenes {
            if ["image", "video"].contains(
                &self
                    .layer(&scene.source_composition_id, &scene.layer_id)?
                    .kind
                    .as_str(),
            ) {
                operations.extend(self.resource_operations(
                    scene,
                    &request.composition_id,
                    &raster,
                    &exposure,
                )?);
            }
        }
        let maximum = self
            .limits
            .cloners
            .max_cloner_instances
            .checked_mul(limits.max_surfaces.saturating_add(1))
            .and_then(|n| n.checked_add(limits.max_surfaces))
            .ok_or_else(|| {
                EvaluationError::InvalidScene("resource request budget overflow".into())
            })?;
        if operations.len() > maximum {
            return Err(EvaluationError::InvalidScene(
                "resource request count exceeds scene budget".into(),
            ));
        }
        Ok(ProjectResourceRequests {
            header,
            operations,
            surface_bindings: sources.bindings,
            diagnostics: sources.diagnostics,
        })
    }

    fn resource_operations(
        &self,
        scene: &EvaluatedSceneLayer,
        frame_composition: &str,
        context: &RetainedRasterContext,
        exposure: &BTreeMap<String, TextExposurePlan>,
    ) -> Result<Vec<ResourcePreparationOperation>, EvaluationError> {
        let raster = self.retained_raster_requests(
            frame_composition,
            std::slice::from_ref(scene),
            context,
            exposure,
        )?;
        if !raster.is_empty() {
            return Ok(raster
                .into_iter()
                .map(|request| ResourcePreparationOperation::Raster { request })
                .collect());
        }
        let layer = self.layer(&scene.source_composition_id, &scene.layer_id)?;
        if !["image", "video"].contains(&layer.kind.as_str()) {
            return Ok(Vec::new());
        }
        Ok(vec![ResourcePreparationOperation::Media {
            composition_id: scene.source_composition_id.clone(),
            layer_id: scene.layer_id.clone(),
            instance_id: scene.resource_instance_id.clone(),
            source_id: layer.source_id.value().cloned(),
            // Native media acquisition applies the layer clock using admitted source duration.
            local_time: scene.local_time,
        }])
    }
}

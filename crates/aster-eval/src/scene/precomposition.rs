use super::{
    EvaluatedSceneLayer, PrecompositionSurface, SceneProject,
    surface_budget::{SurfaceBudget, SurfaceKey, SurfaceLimits, SurfaceRequest, SurfaceTarget},
};
use crate::{EvaluationError, TextExposurePlan, TextExposureRequest, TextLayouts};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SurfacePreparation {
    Target {
        target: SurfaceTarget,
    },
    Media {
        scene: Box<EvaluatedSceneLayer>,
        #[serde(rename = "resolutionScale")]
        resolution_scale: f64,
        #[serde(rename = "textMotionBlur", skip_serializing_if = "Option::is_none")]
        text_motion_blur: Option<TextExposurePlan>,
    },
    Scene {
        source: SurfaceSource,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceSource {
    pub target: SurfaceTarget,
    pub composition_id: String,
    pub time: f64,
    pub layers: Vec<EvaluatedSceneLayer>,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrecompositionSources {
    pub operations: Vec<SurfacePreparation>,
    pub bindings: BTreeMap<String, String>,
    #[serde(skip)]
    pub binding_order: Vec<String>,
    pub active_keys: BTreeSet<String>,
    pub diagnostics: Vec<String>,
    pub budget: SurfaceBudget,
}
struct PreparationState {
    result: PrecompositionSources,
    prepared_sources: BTreeMap<String, String>,
    request: SurfaceRequest,
    limits: SurfaceLimits,
}

impl PrecompositionSources {
    fn bind(&mut self, instance: &str, target: &str) {
        if !self.bindings.contains_key(instance) {
            self.binding_order.push(instance.into());
        }
        self.bindings.insert(instance.into(), target.into());
    }
}

impl SceneProject {
    /// Resolves raw child scenes with temporal text disabled, matching the explicit host option.
    pub fn precomposition_sources(
        &self,
        scenes: &[EvaluatedSceneLayer],
        request: SurfaceRequest,
        limits: &SurfaceLimits,
    ) -> Result<PrecompositionSources, EvaluationError> {
        self.prepare_surfaces(scenes, request, limits, None)
    }

    pub fn precomposition_sources_with_text(
        &self,
        scenes: &[EvaluatedSceneLayer],
        request: SurfaceRequest,
        limits: &SurfaceLimits,
        layouts: &TextLayouts,
        locale: &str,
    ) -> Result<PrecompositionSources, EvaluationError> {
        self.prepare_surfaces(scenes, request, limits, Some((layouts, locale)))
    }

    fn prepare_surfaces(
        &self,
        scenes: &[EvaluatedSceneLayer],
        request: SurfaceRequest,
        limits: &SurfaceLimits,
        text: Option<(&TextLayouts, &str)>,
    ) -> Result<PrecompositionSources, EvaluationError> {
        if request.revision > 9_007_199_254_740_991
            || !request.render_scale.is_finite()
            || !(1.0..=4.0).contains(&request.render_scale)
            || request.max_texture_dimension == 0
            || request.max_texture_dimension > 16384
            || request.memory_budget_mb.is_some_and(|v| !v.is_finite())
        {
            return Err(EvaluationError::InvalidScene(
                "invalid precomposition device limits".into(),
            ));
        }
        let mut state = PreparationState {
            result: PrecompositionSources::default(),
            prepared_sources: BTreeMap::new(),
            request,
            limits: limits.clone(),
        };
        for scene in scenes {
            state.visit(self, scene, text)?;
        }
        Ok(state.result)
    }

    fn surface_children(
        &self,
        surface: &PrecompositionSurface,
        resource_id: &str,
        time: f64,
    ) -> Result<Vec<EvaluatedSceneLayer>, EvaluationError> {
        let mut children = self.evaluate(&surface.composition_id, time)?;
        for child in &mut children {
            child.instance_id = format!("surface:{}/{}", resource_id, child.instance_id);
            child.resource_instance_id =
                format!("surface:{}/{}", resource_id, child.resource_instance_id);
            if let Some(child_surface) = &mut child.precomposition_surface {
                child_surface.composition_path = surface
                    .composition_path
                    .iter()
                    .chain(&child_surface.composition_path)
                    .cloned()
                    .collect();
            }
        }
        Ok(children)
    }
}

impl PreparationState {
    fn visit(
        &mut self,
        project: &SceneProject,
        scene: &EvaluatedSceneLayer,
        text: Option<(&TextLayouts, &str)>,
    ) -> Result<(), EvaluationError> {
        let Some(surface) = &scene.precomposition_surface else {
            return Ok(());
        };
        let source_index = project.composition_index(&surface.composition_id)?;
        let composition = &project.project.compositions[source_index];
        let logical = format!(
            "{}:{}:{}",
            self.request.revision,
            composition.id,
            SurfaceKey::time(surface.time)?
        );
        if let Some(shared) = self.prepared_sources.get(&logical) {
            self.result.bind(&scene.instance_id, shared);
            return Ok(());
        }
        let mut children =
            match project.surface_children(surface, &scene.resource_instance_id, surface.time) {
                Ok(children) => children,
                Err(error) => {
                    self.result.diagnostics.push(error.to_string());
                    return Ok(());
                }
            };
        let mut effects = false;
        for child in &children {
            let source = project.composition_index(&child.source_composition_id)?;
            let layer = &project.project.compositions[source].layers
                [project.compositions[source].layer_indices[&child.layer_id]];
            effects |= layer.kind == "adjustment"
                || !["normal", "add", "screen"].contains(&layer.blend_mode.as_str())
                || layer.effects.iter().any(|e| e.enabled);
        }
        let decision = self.result.budget.allocate(
            composition,
            surface,
            effects,
            &self.request,
            &self.limits,
        )?;
        if let Some(diagnostic) = &decision.diagnostic {
            self.result.diagnostics.push(diagnostic.clone());
        }
        if self.request.render_scale > 1.0 && (decision.target.is_none() || decision.downgraded) {
            return Err(EvaluationError::InvalidScene(format!(
                "SSAA precomposition target unavailable: {}. Choose a lower AA mode or resolution.",
                decision.diagnostic.as_deref().unwrap_or("undefined")
            )));
        }
        let Some(target) = decision.target else {
            return Ok(());
        };
        self.prepared_sources.insert(logical, target.id.clone());
        self.result.bind(&scene.instance_id, &target.id);
        if !self.result.active_keys.insert(target.id.clone()) {
            return Ok(());
        }
        self.result.operations.push(SurfacePreparation::Target {
            target: target.clone(),
        });
        let width = composition
            .width
            .as_f64()
            .ok_or_else(|| EvaluationError::InvalidScene("surface width".into()))?;
        let height = composition
            .height
            .as_f64()
            .ok_or_else(|| EvaluationError::InvalidScene("surface height".into()))?;
        let resolution_scale = (f64::from(target.width) / width.max(1.0))
            .max(f64::from(target.height) / height.max(1.0));
        let plans = if let Some((layouts, locale)) = text {
            let exposure = project.text_exposure_scenes(
                &TextExposureRequest {
                    composition_id: composition.id.clone(),
                    time: surface.time,
                    resolution_scale,
                    locale: locale.into(),
                },
                layouts,
                children,
                |time| project.surface_children(surface, &scene.resource_instance_id, time),
            )?;
            children = exposure.render_scene_layers;
            exposure.plans
        } else {
            BTreeMap::new()
        };
        for child in &children {
            let source = project.composition_index(&child.source_composition_id)?;
            let layer = &project.project.compositions[source].layers
                [project.compositions[source].layer_indices[&child.layer_id]];
            if ["text", "image", "video"].contains(&layer.kind.as_str()) {
                self.result.operations.push(SurfacePreparation::Media {
                    scene: Box::new(child.clone()),
                    resolution_scale,
                    text_motion_blur: plans.get(&child.resource_instance_id).cloned(),
                });
            }
            if child.precomposition_surface.is_some() {
                self.visit(project, child, text)?;
            }
        }
        self.result.operations.push(SurfacePreparation::Scene {
            source: SurfaceSource {
                target,
                composition_id: composition.id.clone(),
                time: surface.time,
                layers: children,
            },
        });
        Ok(())
    }
}

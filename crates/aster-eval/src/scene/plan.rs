use super::{EvaluatedSceneLayer, SceneProject, TextGeometryBounds};
use crate::{EvaluationError, FramePlanRequest, NativePlan};
use aster_render_ir::{
    CompositionIdentity, ContractLevel, ElementType, PlanSlice, SceneBuffersSlice, SceneDrawRecord,
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
pub struct SceneFramePlans {
    pub scene: NativePlan,
    pub post: NativePlan,
}

impl SceneFramePlans {
    pub fn with_media(
        mut self,
        bindings: Vec<aster_render_ir::SceneMediaBinding>,
    ) -> Result<Self, EvaluationError> {
        if self.scene.metadata.contract_level != ContractLevel::SceneBuffersSliceV1
            || self.scene.metadata.slices.len() != 1
        {
            return Err(EvaluationError::InvalidScene(
                "invalid media scene contract".into(),
            ));
        }
        let Some(PlanSlice::SceneBuffers(slice)) = self.scene.metadata.slices.first_mut() else {
            return Err(EvaluationError::InvalidScene(
                "missing media scene buffer".into(),
            ));
        };
        if !slice.media_bindings.is_empty() {
            return Err(EvaluationError::InvalidScene(
                "scene media already bound".into(),
            ));
        }
        slice.media_bindings = bindings;
        let mut resources: std::collections::BTreeSet<_> =
            self.scene.metadata.resources.iter().cloned().collect();
        for binding in &slice.media_bindings {
            if let aster_render_ir::MediaDrawBinding::Frame { hash } = &binding.binding {
                resources.insert(hash.clone());
            }
        }
        self.scene.metadata.resources = resources.into_iter().collect();
        self.scene
            .metadata
            .validate(&aster_render_ir::DecodeLimits::default())
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        Ok(self)
    }

    pub fn with_motion(mut self, vectors: &[f32]) -> Result<Self, EvaluationError> {
        let Some(PlanSlice::SceneBuffers(mut slice)) = self.scene.metadata.slices.first().cloned()
        else {
            return Err(EvaluationError::InvalidScene(
                "missing motion scene buffer".into(),
            ));
        };
        if slice.motion_vectors
            || vectors.len() != slice.vertex_count as usize * 2
            || vectors.iter().any(|n| !n.is_finite())
        {
            return Err(EvaluationError::InvalidScene(
                "motion vectors differ from scene vertices".into(),
            ));
        }
        let Some(mut bytes) = self.scene.blobs.first().cloned() else {
            return Err(EvaluationError::InvalidScene(
                "missing scene payload".into(),
            ));
        };
        bytes.extend(vectors.iter().flat_map(|n| n.to_le_bytes()));
        slice.motion_vectors = true;
        self.scene = NativePlan::single(
            self.scene.metadata.header.clone(),
            ContractLevel::SceneBuffersSliceV1,
            PlanSlice::SceneBuffers(slice),
            ElementType::F32Le,
            bytes,
            self.scene.metadata.resources.clone(),
        )?;
        Ok(self)
    }
}

impl SceneProject {
    /// Evaluates source geometry and lighting before publishing validated scene/post producers.
    pub fn plan_scene_frame(
        &self,
        request: &FramePlanRequest,
        text_bounds: &BTreeMap<String, TextGeometryBounds>,
    ) -> Result<SceneFramePlans, EvaluationError> {
        let layers = self.evaluate(&request.composition_id, request.time)?;
        self.plan_evaluated_scene(request, &layers, text_bounds)
    }

    pub fn plan_evaluated_scene(
        &self,
        request: &FramePlanRequest,
        layers: &[EvaluatedSceneLayer],
        text_bounds: &BTreeMap<String, TextGeometryBounds>,
    ) -> Result<SceneFramePlans, EvaluationError> {
        let geometry =
            self.geometry_for_scene(&request.composition_id, request.time, layers, text_bounds)?;
        self.plan_geometry_scene(request, layers, &geometry)
    }

    pub(super) fn plan_geometry_scene(
        &self,
        request: &FramePlanRequest,
        layers: &[EvaluatedSceneLayer],
        geometry: &super::SceneGeometry,
    ) -> Result<SceneFramePlans, EvaluationError> {
        let index = self.composition_index(&request.composition_id)?;
        let header = request.header(&self.project.compositions[index])?;
        let camera = self.camera(&request.composition_id, request.time)?;
        let lighting = self.lighting(
            &request.composition_id,
            layers,
            request.shadows_enabled,
            camera.as_ref().map(|c| c.pose.position),
        )?;
        let mut draws = Vec::with_capacity(geometry.batches.len());
        let by_instance: BTreeMap<_, _> =
            layers.iter().map(|l| (l.instance_id.as_str(), l)).collect();
        for batch in &geometry.batches {
            let source = by_instance.get(batch.instance_id.as_str()).ok_or_else(|| {
                EvaluationError::InvalidScene("geometry instance not in scene".into())
            })?;
            let composition_index = self.composition_index(&source.source_composition_id)?;
            let layer_index = self.compositions[composition_index].layer_indices[&source.layer_id];
            draws.push(SceneDrawRecord {
                instance_id: CompositionIdentity::Unicode(batch.instance_id.clone()),
                resource_instance_id: CompositionIdentity::Unicode(
                    batch.resource_instance_id.clone(),
                ),
                selection_id: CompositionIdentity::Unicode(batch.selection_id.clone()),
                first_vertex: u32::try_from(batch.first_vertex).map_err(|_| {
                    EvaluationError::InvalidScene("vertex offset exceeds wire range".into())
                })?,
                vertex_count: u32::try_from(batch.vertex_count).map_err(|_| {
                    EvaluationError::InvalidScene("vertex count exceeds wire range".into())
                })?,
                casts_shadow: self.project.compositions[composition_index].layers[layer_index]
                    .three_dimensional,
            });
        }
        let count = u32::try_from(geometry.data.len() / 40).map_err(|_| {
            EvaluationError::InvalidScene("scene vertex count exceeds wire range".into())
        })?;
        let bytes = lighting
            .data
            .iter()
            .chain(&geometry.data)
            .flat_map(|n| n.to_le_bytes())
            .collect();
        let scene = NativePlan::single(
            header.clone(),
            ContractLevel::SceneBuffersSliceV1,
            PlanSlice::SceneBuffers(SceneBuffersSlice {
                blob_index: 0,
                vertex_count: count,
                motion_vectors: false,
                shadows_enabled: request.shadows_enabled,
                draws,
                media_bindings: Vec::new(),
            }),
            ElementType::F32Le,
            bytes,
            Vec::new(),
        )?;
        let post = NativePlan::post(header, request.time)?;
        Ok(SceneFramePlans { scene, post })
    }
}

use super::{EvaluatedSceneLayer, SceneProject};
use crate::{
    CameraProjector, EvaluationError, FlattenedShapePath, GeometryContext, LayerGeometry,
    ResolvedMaskPath, SceneLighting, vertex::VertexPaint,
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneGeometryRecord {
    pub instance_id: String,
    pub resource_instance_id: String,
    pub selection_id: String,
    pub first_vertex: usize,
    pub vertex_count: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct SceneGeometry {
    pub data: Vec<f32>,
    pub batches: Vec<SceneGeometryRecord>,
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct TextGeometryBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct ShapeGraphEvaluation {
    pub shapes: Vec<FlattenedShapePath>,
    pub masks: Vec<ResolvedMaskPath>,
}

impl SceneProject {
    pub fn effects(
        &self,
        composition_id: &str,
        layer_id: &str,
    ) -> Result<&[crate::EffectTrack], EvaluationError> {
        let index = self.composition_index(composition_id)?;
        let layer_index = self.compositions[index]
            .layer_indices
            .get(layer_id)
            .ok_or_else(|| EvaluationError::InvalidScene("unknown effect layer".into()))?;
        Ok(&self.compositions[index].layers[*layer_index].effects)
    }
    pub fn text_animator(
        &self,
        composition_id: &str,
        layer_id: &str,
    ) -> Result<Option<&crate::TextAnimatorTrack>, EvaluationError> {
        let index = self.composition_index(composition_id)?;
        let layer_index = self.compositions[index]
            .layer_indices
            .get(layer_id)
            .ok_or_else(|| EvaluationError::InvalidScene("unknown text layer".into()))?;
        Ok(self.compositions[index].layers[*layer_index].text.as_ref())
    }

    pub fn shape_graph(
        &self,
        composition_id: &str,
        layer_id: &str,
        time: f64,
    ) -> Result<ShapeGraphEvaluation, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let index = self.composition_index(composition_id)?;
        let layer_index = self.compositions[index]
            .layer_indices
            .get(layer_id)
            .ok_or_else(|| EvaluationError::InvalidScene("unknown shape layer".into()))?;
        let Some(graph) = &self.compositions[index].layers[*layer_index].shape_graph else {
            return Ok(ShapeGraphEvaluation {
                shapes: Vec::new(),
                masks: Vec::new(),
            });
        };
        Ok(ShapeGraphEvaluation {
            shapes: graph.evaluate(time)?,
            masks: graph.masks(&self.project.compositions[index].layers[*layer_index]),
        })
    }

    pub fn geometry(
        &self,
        composition_id: &str,
        scene: &[EvaluatedSceneLayer],
        camera: &CameraProjector,
        text_bounds: &BTreeMap<String, TextGeometryBounds>,
    ) -> Result<SceneGeometry, EvaluationError> {
        let size = self.compositions[self.composition_index(composition_id)?].size;
        let mut output = SceneGeometry {
            data: Vec::new(),
            batches: Vec::new(),
        };
        for entry in scene.iter().rev() {
            let source = self.composition_index(&entry.source_composition_id)?;
            let layer_index = self.compositions[source]
                .layer_indices
                .get(&entry.layer_id)
                .ok_or_else(|| EvaluationError::InvalidScene("unknown geometry layer".into()))?;
            let Some(geometry) = &self.compositions[source].layers[*layer_index].geometry else {
                continue;
            };
            let layer = &self.project.compositions[source].layers[*layer_index];
            let bounds = if layer.kind == "text" {
                text_bounds.get(&entry.resource_instance_id)
            } else {
                None
            };
            let source_size = if let Some(bounds) = bounds {
                [bounds.width, bounds.height]
            } else if layer.three_dimensional
                && let Some(surface) = &entry.precomposition_surface
            {
                self.compositions[self.composition_index(&surface.composition_id)?].size
            } else if layer.kind == "solid"
                && let Some(solid) = layer.solid.value()
            {
                VertexPaint::numbers::<2>(&[solid.width.clone(), solid.height.clone()])?
            } else {
                VertexPaint::numbers::<2>(&layer.size)?
            };
            let context = GeometryContext {
                composition_size: size,
                source_size,
                origin: bounds.map_or([0.0, 0.0], |b| [b.x, b.y]),
                local_time: entry.local_time,
            };
            let data = geometry.evaluate(
                layer,
                &entry.transform,
                &context,
                camera,
                &self.limits.paths,
            )?;
            let first_vertex = output.data.len() / 40;
            let vertex_count = data.len() / 40;
            if first_vertex
                .checked_add(vertex_count)
                .is_none_or(|n| n > self.limits.geometry.max_mesh_indices)
            {
                return Err(EvaluationError::InvalidScene(
                    "scene vertex output exceeds budget".into(),
                ));
            }
            output.batches.push(SceneGeometryRecord {
                instance_id: entry.instance_id.clone(),
                resource_instance_id: entry.resource_instance_id.clone(),
                selection_id: entry.selection_id.clone(),
                first_vertex,
                vertex_count,
            });
            output.data.extend(data);
        }
        Ok(output)
    }
    /// Builds lighting from the already evaluated scene, including flattened composition lights.
    pub fn lighting(
        &self,
        composition_id: &str,
        scene: &[EvaluatedSceneLayer],
        shadows_available: bool,
        camera_position: Option<[f64; 3]>,
    ) -> Result<SceneLighting, EvaluationError> {
        let size = self.compositions[self.composition_index(composition_id)?].size;
        let mut inputs = Vec::new();
        for entry in scene {
            inputs.push((
                self.layer(&entry.source_composition_id, &entry.layer_id)?,
                &entry.transform,
            ));
        }
        SceneLighting::evaluate(inputs, size, shadows_available, camera_position)
    }

    /// Mesh-only component; the complete draw-stage assembler also supplies non-mesh geometry.
    pub fn mesh_geometry(
        &self,
        composition_id: &str,
        scene: &[EvaluatedSceneLayer],
        camera: &CameraProjector,
    ) -> Result<SceneGeometry, EvaluationError> {
        let size = self.compositions[self.composition_index(composition_id)?].size;
        let mut output = SceneGeometry {
            data: Vec::new(),
            batches: Vec::new(),
        };
        for entry in scene.iter().rev() {
            let source = self.composition_index(&entry.source_composition_id)?;
            let layer_index = self.compositions[source]
                .layer_indices
                .get(&entry.layer_id)
                .ok_or_else(|| EvaluationError::InvalidScene("unknown mesh layer".into()))?;
            let Some(LayerGeometry::Mesh(mesh)) =
                &self.compositions[source].layers[*layer_index].geometry
            else {
                continue;
            };
            let first_vertex = output.data.len() / 40;
            let vertex_count = mesh.vertex_count();
            if first_vertex
                .checked_add(vertex_count)
                .is_none_or(|n| n > self.limits.geometry.max_mesh_indices)
            {
                return Err(EvaluationError::InvalidScene(
                    "scene mesh output exceeds geometry budget".into(),
                ));
            }
            let data = mesh.evaluate(
                &self.project.compositions[source].layers[*layer_index],
                &entry.transform,
                size,
                camera,
            )?;
            output.batches.push(SceneGeometryRecord {
                instance_id: entry.instance_id.clone(),
                resource_instance_id: entry.resource_instance_id.clone(),
                selection_id: entry.selection_id.clone(),
                first_vertex,
                vertex_count,
            });
            output.data.extend(data);
        }
        Ok(output)
    }
}

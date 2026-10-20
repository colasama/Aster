use super::{SceneGeometry, SceneGeometryRecord, SceneProject, TextGeometryBounds};
use crate::{CameraProjector, CameraTrack, EvaluationError, EvaluationLimits};
use std::collections::{BTreeMap, BTreeSet};

impl SceneGeometry {
    /// Endpoint matching uses stable identities, never a previously rendered frame.
    pub fn motion_vectors(
        &self,
        open: &Self,
        close: &Self,
        enabled: Option<&BTreeSet<String>>,
    ) -> Result<Vec<f32>, EvaluationError> {
        for geometry in [self, open, close] {
            if !geometry.data.len().is_multiple_of(40)
                || geometry.batches.iter().any(|b| {
                    b.first_vertex
                        .checked_add(b.vertex_count)
                        .is_none_or(|end| end > geometry.data.len() / 40)
                })
            {
                return Err(EvaluationError::InvalidScene(
                    "motion geometry range or vertex alignment".into(),
                ));
            }
        }
        let opening: BTreeMap<_, _> = open
            .batches
            .iter()
            .map(|b| (b.motion_identity(), b))
            .collect();
        let closing: BTreeMap<_, _> = close
            .batches
            .iter()
            .map(|b| (b.motion_identity(), b))
            .collect();
        let mut output = vec![0.0; self.data.len() / 40 * 2];
        for batch in &self.batches {
            if enabled.is_some_and(|ids| !ids.contains(&batch.selection_id)) {
                continue;
            }
            let identity = batch.motion_identity();
            let (Some(a), Some(b)) = (opening.get(&identity), closing.get(&identity)) else {
                continue;
            };
            if a.vertex_count != batch.vertex_count || b.vertex_count != batch.vertex_count {
                continue;
            }
            for vertex in 0..batch.vertex_count {
                for (lane, factor) in [0.5, -0.5].into_iter().enumerate() {
                    let delta = (f64::from(close.data[(b.first_vertex + vertex) * 40 + lane])
                        - f64::from(open.data[(a.first_vertex + vertex) * 40 + lane]))
                        * factor;
                    output[(batch.first_vertex + vertex) * 2 + lane] = if delta.is_finite() {
                        delta.clamp(-8.0, 8.0) as f32
                    } else {
                        0.0
                    };
                }
            }
        }
        Ok(output)
    }
}

impl SceneGeometryRecord {
    fn motion_identity(&self) -> String {
        format!(
            "{}\0{}\0{}",
            self.selection_id, self.instance_id, self.resource_instance_id
        )
    }
}

impl SceneProject {
    pub fn geometry_at(
        &self,
        composition_id: &str,
        time: f64,
        bounds: &BTreeMap<String, TextGeometryBounds>,
    ) -> Result<SceneGeometry, EvaluationError> {
        let layers = self.evaluate(composition_id, time)?;
        self.geometry_for_scene(composition_id, time, &layers, bounds)
    }

    pub fn geometry_for_scene(
        &self,
        composition_id: &str,
        time: f64,
        layers: &[super::EvaluatedSceneLayer],
        bounds: &BTreeMap<String, TextGeometryBounds>,
    ) -> Result<SceneGeometry, EvaluationError> {
        let size = self.compositions[self.composition_index(composition_id)?].size;
        let camera = match self.camera(composition_id, time)? {
            Some(camera) => camera,
            None => CameraTrack::default_evaluated(size, &EvaluationLimits::default())?,
        };
        let projector = CameraProjector::new(&camera.pose, &camera.projection, size);
        self.geometry(composition_id, layers, &projector, bounds)
    }

    pub fn motion_selection_ids(
        &self,
        composition_id: &str,
        time: f64,
        geometry: &SceneGeometry,
    ) -> Result<BTreeSet<String>, EvaluationError> {
        self.evaluated_motion_selection_ids(&self.evaluate(composition_id, time)?, geometry)
    }

    pub fn evaluated_motion_selection_ids(
        &self,
        layers: &[super::EvaluatedSceneLayer],
        geometry: &SceneGeometry,
    ) -> Result<BTreeSet<String>, EvaluationError> {
        let mut ids = BTreeSet::new();
        let instances: BTreeSet<_> = geometry
            .batches
            .iter()
            .map(|b| b.instance_id.as_str())
            .collect();
        for entry in layers {
            if !instances.contains(entry.instance_id.as_str()) {
                continue;
            }
            let source = self.composition_index(&entry.source_composition_id)?;
            let layer = &self.project.compositions[source].layers
                [self.compositions[source].layer_indices[&entry.layer_id]];
            if layer.motion_blur.value() == Some(&true)
                && ![
                    "audio",
                    "null",
                    "camera",
                    "light",
                    "adjustment",
                    "generator",
                ]
                .contains(&layer.kind.as_str())
            {
                ids.insert(entry.selection_id.clone());
            }
        }
        Ok(ids)
    }
}

use super::{EvaluatedSceneLayer, SceneProject};
use crate::{EvaluationError, MaterialTextureSettings, NativePlan};
use aster_render_ir::{CompositionIdentity, FrameHeaderSlice, ResourceHash};
use std::collections::BTreeMap;

#[derive(Clone, Default, serde::Deserialize)]
pub struct MaterialResources {
    pub normals: BTreeMap<String, ResourceHash>,
    pub environment: Option<ResourceHash>,
}
#[derive(Clone, Default, serde::Serialize)]
pub struct MaterialTextureSources {
    pub normals: BTreeMap<String, String>,
    pub environment: Option<String>,
}
impl SceneProject {
    /// Authoring addresses are resolved natively; acquisition decides whether their bytes are ready.
    pub fn material_texture_sources(
        &self,
        composition_id: &str,
        time: f64,
    ) -> Result<MaterialTextureSources, EvaluationError> {
        let composition = &self.project.compositions[self.composition_index(composition_id)?];
        let mut sources = MaterialTextureSources::default();
        let mut mesh_present = false;
        for scene in self.evaluate(composition_id, time)? {
            let layer = self.layer(&scene.source_composition_id, &scene.layer_id)?;
            if layer.kind != "mesh" {
                continue;
            }
            mesh_present = true;
            if let Some(normal) = layer
                .mesh
                .value()
                .and_then(|m| m.material_textures.value())
                .and_then(|m| m.normal.value())
                .filter(|n| !n.data_url.is_empty())
            {
                sources
                    .normals
                    .insert(scene.resource_instance_id, normal.data_url.clone());
            }
        }
        if mesh_present
            && let Some(environment) = composition
                .environment
                .value()
                .filter(|e| e.enabled && !e.source.data_url.is_empty())
        {
            sources.environment = Some(environment.source.data_url.clone());
        }
        Ok(sources)
    }

    pub fn plan_materials(
        &self,
        header: FrameHeaderSlice,
        layers: &[EvaluatedSceneLayer],
        resources: &MaterialResources,
    ) -> Result<BTreeMap<String, NativePlan>, EvaluationError> {
        let CompositionIdentity::Unicode(id) = &header.composition_id else {
            return Err(EvaluationError::InvalidScene(
                "material composition identity".into(),
            ));
        };
        let composition = &self.project.compositions[self.composition_index(id)?];
        let mut output = BTreeMap::new();
        for entry in layers {
            let source = self.composition_index(&entry.source_composition_id)?;
            let index = *self.compositions[source]
                .layer_indices
                .get(&entry.layer_id)
                .ok_or_else(|| EvaluationError::InvalidScene("material layer is absent".into()))?;
            let layer = &self.project.compositions[source].layers[index];
            if layer.kind != "mesh" {
                continue;
            }
            let normal = resources.normals.get(&entry.resource_instance_id).cloned();
            let settings = MaterialTextureSettings::evaluate(
                layer,
                composition.environment.value(),
                normal.is_some(),
                resources.environment.is_some(),
            );
            let plan = settings.plan(
                header.clone(),
                CompositionIdentity::Unicode(entry.resource_instance_id.clone()),
                normal,
                resources.environment.clone(),
            )?;
            output.insert(entry.instance_id.clone(), plan);
        }
        Ok(output)
    }
}

use crate::{EvaluationError, NativePlan};
use aster_render_ir::{
    CompositionIdentity, ContractLevel, ElementType, FrameHeaderSlice, MaterialBindingSlice,
    MaterialTextureReference, PlanSlice, ResourceHash,
};
use aster_types::editor::{Environment, Layer};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialTextureSettings {
    pub active: bool,
    pub normal_enabled: bool,
    pub normal_scale: f64,
    pub environment_intensity: f64,
    pub environment_rotation: f64,
}
impl MaterialTextureSettings {
    pub fn evaluate(
        layer: &Layer,
        environment: Option<&Environment>,
        normal_ready: bool,
        environment_ready: bool,
    ) -> Self {
        let normal = if layer.kind == "mesh" {
            layer
                .mesh
                .value()
                .and_then(|m| m.material_textures.value())
                .and_then(|m| m.normal.value())
        } else {
            None
        };
        let normal_enabled = normal.is_some() && normal_ready;
        let normal_scale = normal
            .and_then(|n| n.scale.value())
            .and_then(|n| n.as_f64())
            .filter(|n| n.is_finite())
            .unwrap_or(1.0)
            .clamp(-8.0, 8.0);
        let environment_intensity = environment
            .filter(|e| e.enabled && environment_ready)
            .map_or(0.0, |e| {
                e.intensity
                    .as_f64()
                    .filter(|n| n.is_finite())
                    .unwrap_or(1.0)
                    .clamp(0.0, 32.0)
            });
        let rotation = environment
            .and_then(|e| e.rotation.as_f64())
            .filter(|n| n.is_finite())
            .unwrap_or(0.0);
        Self {
            active: normal_enabled || environment_intensity > 0.0,
            normal_enabled,
            normal_scale,
            environment_intensity,
            environment_rotation: ((rotation % 360.0) + 360.0) % 360.0 / 360.0,
        }
    }
    pub fn plan(
        &self,
        header: FrameHeaderSlice,
        instance_id: CompositionIdentity,
        normal: Option<ResourceHash>,
        environment: Option<ResourceHash>,
    ) -> Result<NativePlan, EvaluationError> {
        if self.normal_enabled != normal.is_some()
            || self.active != (self.normal_enabled || self.environment_intensity > 0.0)
        {
            return Err(EvaluationError::InvalidScene(
                "material activity differs from admitted resources".into(),
            ));
        }
        let mut resources: Vec<_> = normal.iter().chain(environment.iter()).cloned().collect();
        resources.sort();
        let normal = normal.map_or(MaterialTextureReference::Fallback, |hash| {
            MaterialTextureReference::Texture { hash }
        });
        let environment = environment.map_or(MaterialTextureReference::Fallback, |hash| {
            MaterialTextureReference::Texture { hash }
        });
        NativePlan::single(
            header,
            ContractLevel::MaterialBindingsSliceV1,
            PlanSlice::MaterialBinding(MaterialBindingSlice {
                blob_index: 0,
                instance_id,
                normal,
                environment,
            }),
            ElementType::U8,
            [
                self.normal_scale,
                self.environment_intensity,
                self.environment_rotation,
            ]
            .into_iter()
            .flat_map(f64::to_le_bytes)
            .collect(),
            resources,
        )
    }
}

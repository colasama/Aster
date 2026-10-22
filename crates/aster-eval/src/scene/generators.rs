use super::{EvaluatedSceneLayer, SceneProject};
use crate::{
    BundleGenerator, EvaluatedCamera, EvaluationError, GeneratorCatalog, GeneratorContext,
    GeneratorDeviceLimits, GeneratorInvocation,
};
use aster_render_ir::{CompositionIdentity, FrameHeaderSlice, PrecompositionGeneratorExecution};

pub struct GeneratorFrameSettings {
    pub device: GeneratorDeviceLimits,
    pub camera: Option<EvaluatedCamera>,
    pub audio: Option<Vec<u32>>,
}
impl SceneProject {
    pub fn plan_generators(
        &self,
        header: FrameHeaderSlice,
        layers: &[EvaluatedSceneLayer],
        catalog: &GeneratorCatalog,
        settings: &GeneratorFrameSettings,
    ) -> Result<Vec<BundleGenerator>, EvaluationError> {
        let CompositionIdentity::Unicode(id) = &header.composition_id else {
            return Err(EvaluationError::InvalidScene(
                "generator composition identity".into(),
            ));
        };
        let index = self.composition_index(id)?;
        let composition = &self.project.compositions[index];
        let frame_duration = Self::number(&composition.frame_rate.denominator)?
            / Self::number(&composition.frame_rate.numerator)?.max(1.0);
        let mut output = Vec::new();
        for entry in layers {
            let source = self.composition_index(&entry.source_composition_id)?;
            let layer_index = *self.compositions[source]
                .layer_indices
                .get(&entry.layer_id)
                .ok_or_else(|| EvaluationError::InvalidScene("generator layer is absent".into()))?;
            let layer = &self.project.compositions[source].layers[layer_index];
            if layer.kind != "generator" {
                continue;
            }
            let instance = layer.generator.value().ok_or_else(|| {
                EvaluationError::InvalidScene("generator instance is absent".into())
            })?;
            if catalog
                .unavailable
                .contains_key(&(instance.plugin_id.clone(), instance.node_type.clone()))
            {
                continue;
            }
            let admitted = catalog
                .entries
                .get(&(instance.plugin_id.clone(), instance.node_type.clone()))
                .ok_or_else(|| {
                    EvaluationError::InvalidScene(format!(
                        "generator {}:{} is not admitted",
                        instance.plugin_id, instance.node_type
                    ))
                })?;
            let context = GeneratorContext {
                composition_size: self.compositions[index].size,
                render_size: [
                    f64::from(header.render_target.width),
                    f64::from(header.render_target.height),
                ],
                composition_time: entry.local_time,
                source_time: self.compositions[source].layers[layer_index]
                    .clock
                    .evaluate(entry.local_time, f64::INFINITY)?,
                frame_duration,
                transform: entry.transform.clone(),
                selection_id: entry.selection_id.clone(),
                layer_kind: layer.kind.clone(),
                three_dimensional: layer.three_dimensional,
                camera: settings.camera.clone(),
            };
            let inputs = admitted.definition.prepare(
                instance,
                &context,
                &settings.device,
                &catalog.limits,
            )?;
            let audio = if admitted.definition.audio_analysis {
                settings.audio.as_deref()
            } else {
                None
            };
            let plan = inputs.plan(
                header.clone(),
                GeneratorInvocation {
                    instance_id: CompositionIdentity::Unicode(entry.instance_id.clone()),
                    selection_id: CompositionIdentity::Unicode(entry.selection_id.clone()),
                    blend_mode: serde_json::from_value(serde_json::Value::String(
                        layer.blend_mode.clone(),
                    ))
                    .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?,
                },
                &admitted.program,
                audio,
            )?;
            output.push(BundleGenerator {
                instance_id: CompositionIdentity::Unicode(entry.instance_id.clone()),
                plan,
                shaders: admitted.program.shaders.clone(),
                layer_name_utf16: layer.name.encode_utf16().collect(),
                plugin_id_utf16: instance.plugin_id.encode_utf16().collect(),
                execution: PrecompositionGeneratorExecution::Planned,
            });
        }
        Ok(output)
    }
}

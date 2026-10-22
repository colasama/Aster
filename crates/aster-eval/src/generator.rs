mod catalog;
mod context;
pub use catalog::{GeneratorCatalog, UnavailableGenerator, UnavailableGeneratorReason};
mod parameters;
mod plan;
pub use plan::{GeneratorInvocation, GeneratorProgramSource, NativeGeneratorProgram};

use crate::{EvaluationError, expression::NumericFunction};
use aster_plugin::generator::{GeneratorLimits, SceneGeneratorGraph};
use aster_types::editor::{Generator, GeneratorParameter};
pub use context::GeneratorContext;
pub use parameters::GeneratorParameterDefinition;
use serde::{Deserialize, Serialize};

/// An admitted generator contract; shader authorization remains with the plugin resource boundary.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorDefinition {
    pub plugin_id: String,
    pub node_type: String,
    pub api_version: u32,
    pub parameters: Vec<GeneratorParameterDefinition>,
    pub graph: SceneGeneratorGraph,
    pub audio_analysis: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorDeviceLimits {
    pub memory_budget_mb: f64,
    pub storage_byte_limit: u64,
    pub dispatch_workgroup_limit: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratorInputs {
    pub variant_index: usize,
    pub requested_count: u32,
    pub effective_count: u32,
    pub capacity: u32,
    pub context: Vec<u32>,
    pub parameters: Vec<u32>,
    pub indirect: [u32; 4],
    pub dispatches: Vec<[u32; 3]>,
}

impl GeneratorDefinition {
    pub fn validate(&self, limits: &GeneratorLimits) -> Result<(), EvaluationError> {
        self.graph
            .validate(limits)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        if self.api_version != 1
            || self.node_type != self.graph.node_type
            || self.parameters.len() > 128
            || self.plugin_id.is_empty()
        {
            return Err(EvaluationError::InvalidScene(
                "invalid generator contract".into(),
            ));
        }
        let mut names = std::collections::BTreeSet::new();
        for parameter in &self.parameters {
            parameter.validate()?;
            if !names.insert(parameter.name()) {
                return Err(EvaluationError::InvalidScene(
                    "duplicate generator parameter".into(),
                ));
            }
        }
        if !self.parameters.iter().any(|p| matches!(p,GeneratorParameterDefinition::Number {name,..} if name == &self.graph.capacity_parameter)) {
            return Err(EvaluationError::InvalidScene("missing numeric capacity parameter".into()));
        }
        if let Some(name) = &self.graph.render_parameter {
            let Some(GeneratorParameterDefinition::Choice { choices, .. }) =
                self.parameters.iter().find(|p| p.name() == name)
            else {
                return Err(EvaluationError::InvalidScene(
                    "missing render selector".into(),
                ));
            };
            if self.graph.render_variants.iter().any(|v| {
                v.selector_value
                    .as_ref()
                    .is_none_or(|s| !choices.contains(s))
            }) {
                return Err(EvaluationError::InvalidScene(
                    "unknown render selector value".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn prepare(
        &self,
        instance: &Generator,
        context: &GeneratorContext,
        device: &GeneratorDeviceLimits,
        limits: &GeneratorLimits,
    ) -> Result<GeneratorInputs, EvaluationError> {
        self.validate(limits)?;
        if instance.api_version.as_u64() != Some(u64::from(self.api_version))
            || instance.plugin_id != self.plugin_id
            || instance.node_type != self.node_type
            || instance.parameters.len() > 128
        {
            return Err(EvaluationError::InvalidScene(
                "generator instance differs from contract".into(),
            ));
        }
        let selector =
            self.graph
                .render_parameter
                .as_ref()
                .map(|name| match instance.parameters.get(name) {
                    Some(GeneratorParameter::Text(value)) => value.clone(),
                    Some(GeneratorParameter::Number(value)) => {
                        crate::javascript::JavaScriptNumber::number(value)
                    }
                    Some(GeneratorParameter::Boolean(value)) => value.to_string(),
                    Some(GeneratorParameter::Numbers(value)) => value
                        .iter()
                        .map(crate::javascript::JavaScriptNumber::number)
                        .collect::<Vec<_>>()
                        .join(","),
                    None => String::new(),
                });
        let variant_index = self
            .graph
            .render_variants
            .iter()
            .position(|v| v.selector_value == selector)
            .unwrap_or(0);
        let variant = &self.graph.render_variants[variant_index];
        let fallback = self
            .parameters
            .iter()
            .find_map(|p| match p {
                GeneratorParameterDefinition::Number { name, default, .. }
                    if name == &self.graph.capacity_parameter =>
                {
                    Some(*default)
                }
                _ => None,
            })
            .unwrap_or(1.);
        let requested = match instance.parameters.get(&self.graph.capacity_parameter) {
            Some(GeneratorParameter::Number(value)) => {
                value.as_f64().filter(|n| n.is_finite()).unwrap_or(fallback)
            }
            _ => fallback,
        };
        let requested_count =
            NumericFunction::round(requested).clamp(1., f64::from(self.graph.max_instances)) as u32;
        if device.storage_byte_limit < u64::from(self.graph.instance_stride)
            || device.dispatch_workgroup_limit == 0
        {
            return Err(EvaluationError::InvalidScene(
                "device cannot admit one generator instance".into(),
            ));
        }
        let budget = if device.memory_budget_mb.is_finite() {
            device.memory_budget_mb.max(16.)
        } else {
            512.
        };
        let memory_limit = (budget * 1024. * 1024. * 0.125 / f64::from(self.graph.instance_stride))
            .floor()
            .max(1024.);
        let storage_limit = (device.storage_byte_limit / u64::from(self.graph.instance_stride))
            .min(u64::from(u32::MAX)) as u32;
        let group_size = self
            .graph
            .compute_passes
            .iter()
            .map(|p| p.workgroup_size[0])
            .min()
            .ok_or_else(|| {
                EvaluationError::InvalidScene("missing generator compute pass".into())
            })?;
        let dispatch_limit = device.dispatch_workgroup_limit.saturating_mul(group_size);
        let vertex_limit = (budget * 12288. / f64::from(variant.vertex_count.max(1)))
            .floor()
            .max(16384.);
        let effective_count = requested_count
            .min(self.graph.max_instances)
            .min(memory_limit as u32)
            .min(storage_limit)
            .min(dispatch_limit)
            .min(vertex_limit as u32);
        let ceiling = self.graph.max_instances.min(storage_limit);
        let capacity = f64::from(ceiling.min(effective_count.max(1024)))
            .log2()
            .ceil()
            .exp2()
            .min(f64::from(ceiling)) as u32;
        let parameters = self.pack_parameters(instance)?;
        Ok(GeneratorInputs {
            variant_index,
            requested_count,
            effective_count,
            capacity,
            context: context.pack(effective_count)?,
            parameters: parameters.into_iter().map(f32::to_bits).collect(),
            indirect: [variant.vertex_count, 0, 0, 0],
            dispatches: self
                .graph
                .compute_passes
                .iter()
                .map(|p| [effective_count.div_ceil(p.workgroup_size[0]), 1, 1])
                .collect(),
        })
    }
}

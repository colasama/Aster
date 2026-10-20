use super::GeneratorDefinition;
use crate::EvaluationError;
use aster_types::editor::{Generator, GeneratorParameter};
use serde::Deserialize;

/// Authoring scalars retain f64 precision until the shared GPU parameter boundary.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum GeneratorParameterDefinition {
    Number {
        name: String,
        default: f64,
        min: f64,
        max: f64,
    },
    Choice {
        name: String,
        default: String,
        choices: Vec<String>,
    },
    Color {
        name: String,
        default: [f64; 4],
    },
    Vector {
        name: String,
        default: Vec<f64>,
        min: f64,
        max: f64,
    },
}

impl GeneratorParameterDefinition {
    pub fn name(&self) -> &str {
        match self {
            Self::Number { name, .. }
            | Self::Choice { name, .. }
            | Self::Color { name, .. }
            | Self::Vector { name, .. } => name,
        }
    }
    pub(super) fn validate(&self) -> Result<(), EvaluationError> {
        let name = self.name();
        let mut chars = name.chars();
        let valid_name = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
        let bounded = |n: f64, min: f64, max: f64| {
            n.is_finite() && min.is_finite() && max.is_finite() && n >= min && n <= max
        };
        let valid = match self {
            Self::Number {
                default, min, max, ..
            } => bounded(*default, *min, *max),
            Self::Choice {
                default, choices, ..
            } => !choices.is_empty() && choices.len() <= 128 && choices.contains(default),
            Self::Color { default, .. } => default.iter().all(|n| bounded(*n, 0., 1.)),
            Self::Vector {
                default, min, max, ..
            } => {
                !default.is_empty()
                    && default.len() <= 4
                    && default.iter().all(|n| bounded(*n, *min, *max))
            }
        };
        if valid_name && valid {
            Ok(())
        } else {
            Err(EvaluationError::InvalidScene(
                "invalid generator parameter definition".into(),
            ))
        }
    }
}

impl GeneratorDefinition {
    pub(super) fn pack_parameters(
        &self,
        instance: &Generator,
    ) -> Result<Vec<f32>, EvaluationError> {
        let mut output = vec![0.; 512];
        for (i, parameter) in self.parameters.iter().enumerate() {
            let value = instance.parameters.get(parameter.name());
            let row = &mut output[i * 4..i * 4 + 4];
            match parameter {
                GeneratorParameterDefinition::Number {
                    default, min, max, ..
                } => {
                    let number = match value {
                        Some(GeneratorParameter::Number(n)) => {
                            n.as_f64().filter(|n| n.is_finite()).unwrap_or(*default)
                        }
                        _ => *default,
                    };
                    row[0] = number.clamp(*min, *max) as f32;
                }
                GeneratorParameterDefinition::Choice {
                    default, choices, ..
                } => {
                    let choice = match value {
                        Some(GeneratorParameter::Text(s)) if choices.contains(s) => s,
                        _ => default,
                    };
                    row[0] = choices
                        .iter()
                        .position(|s| s == choice)
                        .map_or(-1., |i| i as f32);
                }
                GeneratorParameterDefinition::Color { default, .. } => {
                    Self::pack_vector(value, default, 0., 1., row)
                }
                GeneratorParameterDefinition::Vector {
                    default, min, max, ..
                } => Self::pack_vector(value, default, *min, *max, row),
            }
        }
        if output.iter().any(|n| !n.is_finite()) {
            return Err(EvaluationError::InvalidScene(
                "nonfinite generator GPU parameter".into(),
            ));
        }
        Ok(output)
    }
    fn pack_vector(
        value: Option<&GeneratorParameter>,
        fallback: &[f64],
        minimum: f64,
        maximum: f64,
        output: &mut [f32],
    ) {
        let values = match value {
            Some(GeneratorParameter::Numbers(values)) if values.len() == fallback.len() => values
                .iter()
                .map(|n| n.as_f64().filter(|n| n.is_finite()))
                .collect::<Option<Vec<_>>>(),
            _ => None,
        };
        for (out, n) in output.iter_mut().zip(values.as_deref().unwrap_or(fallback)) {
            *out = n.clamp(minimum, maximum) as f32;
        }
    }
}

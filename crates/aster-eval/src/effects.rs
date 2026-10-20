mod color;
mod mask;
mod program;

use crate::{
    EvaluationError, EvaluationLimits, ExpressionBinding, ExpressionContext, ExpressionLimits,
    ScalarTrack,
};
use aster_types::editor::{Animatable, Effect};
pub use color::EffectColorTrack;
pub use mask::EffectMaskInput;
pub use program::EffectProgram;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

#[derive(Clone, Debug, clap::Args)]
pub struct EffectLimits {
    #[arg(long, default_value_t=Self::default().max_effect_parameters)]
    pub max_effect_parameters: usize,
    #[arg(long, default_value_t=Self::default().max_layer_effects)]
    pub max_layer_effects: usize,
}
impl Default for EffectLimits {
    fn default() -> Self {
        Self {
            max_effect_parameters: 2048,
            max_layer_effects: 1024,
        }
    }
}

#[derive(Clone, Debug)]
pub struct EffectTrack {
    pub id: String,
    pub effect_type: String,
    pub enabled: bool,
    pub mask: Option<EffectMaskInput>,
    parameters: BTreeMap<String, ParameterTrack>,
    colors: BTreeMap<String, EffectColorTrack>,
    lut_domain_min: [f64; 3],
    lut_domain_max: [f64; 3],
}
#[derive(Clone, Debug)]
struct ParameterTrack {
    value: Option<ScalarTrack>,
    expression: Option<Arc<ExpressionBinding>>,
}

#[derive(Clone, Debug)]
pub struct EffectFrame {
    pub time: f64,
    pub lut_domain_min: [f64; 3],
    pub lut_domain_max: [f64; 3],
    parameters: BTreeMap<String, ParameterValue>,
    colors: BTreeMap<String, f64>,
}
#[derive(Clone, Debug)]
struct ParameterValue {
    value: Option<f64>,
    expression: Option<Arc<ExpressionBinding>>,
}

#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelParameter {
    pub key: String,
    pub default_value: f64,
}

impl EffectTrack {
    pub fn compile(
        effect: &Effect,
        limits: &EffectLimits,
        evaluation: &EvaluationLimits,
        expressions: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        let keys: BTreeSet<_> = effect
            .parameters
            .keys()
            .chain(
                effect
                    .parameter_keyframes
                    .value()
                    .into_iter()
                    .flat_map(|v| v.keys()),
            )
            .chain(
                effect
                    .parameter_expressions
                    .value()
                    .into_iter()
                    .flat_map(|v| v.keys()),
            )
            .collect();
        if keys.len() > limits.max_effect_parameters {
            return Err(EvaluationError::InvalidProperty(
                "effect parameter budget exceeded".into(),
            ));
        }
        let mut parameters = BTreeMap::new();
        let mut colors = BTreeMap::new();
        for key in keys {
            let keys = effect
                .parameter_keyframes
                .value()
                .and_then(|m| m.get(key))
                .filter(|keys| !keys.is_empty());
            let source = if let Some(keys) = keys {
                Some(Animatable::Animated {
                    keyframes: keys.clone(),
                    extensions: BTreeMap::new(),
                })
            } else {
                effect.parameters.get(key).map(|value| Animatable::Static {
                    value: value.clone(),
                    extensions: BTreeMap::new(),
                })
            };
            let value = source
                .as_ref()
                .map(|p| ScalarTrack::compile(p, evaluation))
                .transpose()?;
            let expression = effect
                .parameter_expressions
                .value()
                .and_then(|m| m.get(key))
                .filter(|s| !s.is_empty())
                .map(|s| Arc::new(ExpressionBinding::compile(s, expressions)));
            parameters.insert(key.clone(), ParameterTrack { value, expression });
            if effect.effect_type == "multi-stop-gradient"
                && ["color1", "color2", "color3", "color4", "color5"].contains(&key.as_str())
                && let Some(keys) = keys
            {
                colors.insert(key.clone(), EffectColorTrack::compile(keys, evaluation)?);
            }
        }
        Ok(Self {
            lut_domain_min: effect
                .resource
                .value()
                .map(|r| crate::vertex::VertexPaint::numbers(&r.domain_min))
                .transpose()?
                .unwrap_or([0.0; 3]),
            lut_domain_max: effect
                .resource
                .value()
                .map(|r| crate::vertex::VertexPaint::numbers(&r.domain_max))
                .transpose()?
                .unwrap_or([1.0; 3]),
            id: effect.id.clone(),
            effect_type: effect.effect_type.clone(),
            enabled: effect.enabled,
            mask: effect
                .mask
                .value()
                .map(EffectMaskInput::compile)
                .transpose()?,
            parameters,
            colors,
        })
    }

    pub fn evaluate(&self, time: f64) -> Result<EffectFrame, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let mut parameters = BTreeMap::new();
        for (key, track) in &self.parameters {
            parameters.insert(
                key.clone(),
                ParameterValue {
                    value: track.value.as_ref().map(|v| v.evaluate(time)).transpose()?,
                    expression: track.expression.clone(),
                },
            );
        }
        let colors = self
            .colors
            .iter()
            .map(|(key, track)| Ok((key.clone(), track.evaluate(time)?)))
            .collect::<Result<_, EvaluationError>>()?;
        Ok(EffectFrame {
            lut_domain_min: self.lut_domain_min,
            lut_domain_max: self.lut_domain_max,
            time,
            parameters,
            colors,
        })
    }
}

impl EffectFrame {
    pub fn value(&self, key: &str, fallback: f64) -> f64 {
        let Some(parameter) = self.parameters.get(key) else {
            return fallback;
        };
        let value = parameter.value.unwrap_or(fallback);
        match &parameter.expression {
            Some(expression) => expression.evaluate(ExpressionContext {
                time: self.time,
                value,
            }),
            None => value,
        }
    }

    pub fn gradient_color(&self, key: &str, fallback: f64) -> f64 {
        self.colors.get(key).copied().unwrap_or_else(|| {
            self.parameters
                .get(key)
                .and_then(|p| p.value)
                .unwrap_or(fallback)
        })
    }

    /// Preserve the source renderer's second expression evaluation after pixel-unit scaling.
    pub fn scale_pixels(
        &mut self,
        definitions: &[PixelParameter],
        scale: f64,
    ) -> Result<(), EvaluationError> {
        if !scale.is_finite() {
            return Err(EvaluationError::InvalidProperty(
                "nonfinite effect pixel scale".into(),
            ));
        }
        if scale == 1.0 {
            return Ok(());
        }
        for definition in definitions {
            let value = self.value(&definition.key, definition.default_value) * scale;
            self.parameters
                .entry(definition.key.clone())
                .or_insert(ParameterValue {
                    value: None,
                    expression: None,
                })
                .value = Some(value);
        }
        Ok(())
    }

    pub fn color_channels(value: f64) -> [f64; 3] {
        let color = EffectColorTrack::packed(value);
        [
            f64::from((color >> 16) & 255) / 255.0,
            f64::from((color >> 8) & 255) / 255.0,
            f64::from(color & 255) / 255.0,
        ]
    }
}

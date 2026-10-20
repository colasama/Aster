use crate::{EvaluationError, EvaluationLimits, ScalarTrack, expression::NumericFunction};
use aster_types::editor::{Animatable, Keyframe};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct EffectColorTrack {
    channels: [ScalarTrack; 3],
}
impl EffectColorTrack {
    pub fn compile(keys: &[Keyframe], limits: &EvaluationLimits) -> Result<Self, EvaluationError> {
        let mut channels = Vec::with_capacity(3);
        for shift in [16, 8, 0] {
            let mut channel_keys = keys.to_vec();
            for key in &mut channel_keys {
                let value = key.value.as_f64().ok_or_else(|| {
                    EvaluationError::InvalidProperty("invalid packed effect color".into())
                })?;
                key.value = ((Self::packed(value) >> shift) & 255).into();
            }
            channels.push(ScalarTrack::compile(
                &Animatable::Animated {
                    keyframes: channel_keys,
                    extensions: BTreeMap::new(),
                },
                limits,
            )?);
        }
        Ok(Self {
            channels: channels
                .try_into()
                .map_err(|_| EvaluationError::InvalidProperty("color dimension".into()))?,
        })
    }

    pub fn evaluate(&self, time: f64) -> Result<f64, EvaluationError> {
        let mut packed = 0u32;
        for (track, shift) in self.channels.iter().zip([16, 8, 0]) {
            let channel = NumericFunction::round(track.evaluate(time)?).clamp(0.0, 255.0) as u32;
            packed += channel << shift;
        }
        Ok(f64::from(packed))
    }

    pub(super) fn packed(value: f64) -> u32 {
        NumericFunction::round(value).clamp(0.0, 16_777_215.0) as u32
    }
}

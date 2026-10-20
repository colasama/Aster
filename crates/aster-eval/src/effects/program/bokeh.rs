use super::EffectKernels;
use crate::{EffectFrame, expression::NumericFunction};

impl EffectKernels {
    pub(super) fn bokeh(effect_type: &str, frame: &EffectFrame) -> Option<[f64; 16]> {
        if effect_type != "fast-bokeh" {
            return None;
        }
        let blades = Self::choice(
            frame.value("irisShape", 5.0),
            &[3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 64.0],
            6.0,
        );
        let samples = Self::choice(frame.value("quality", 1.0), &[16.0, 24.0, 32.0], 24.0);
        Some([
            268.0,
            frame.value("radius", 40.0),
            frame.value("depthSource", 0.0),
            if frame.value("invertDepth", 0.0) > 0.5 {
                -1.0
            } else {
                1.0
            },
            frame.value("focus", 0.5),
            frame.value("focusRange", 0.12).max(0.001),
            frame.value("focusCenterX", 50.0) / 100.0,
            frame.value("focusCenterY", 50.0) / 100.0,
            blades,
            frame.value("irisRotation", 0.0) * std::f64::consts::PI / 180.0,
            frame.value("irisRoundness", 0.0) / 100.0,
            frame.value("irisAspect", 1.0),
            (frame.value("highlightGain", 0.0) / 100.0) * 8.0,
            frame.value("highlightThreshold", 0.85),
            frame.value("highlightSaturation", 100.0) / 100.0,
            samples,
        ])
    }

    fn choice(value: f64, values: &[f64], fallback: f64) -> f64 {
        let index = NumericFunction::round(value);
        if index >= 0.0 && index < values.len() as f64 {
            values[index as usize]
        } else {
            fallback
        }
    }
}

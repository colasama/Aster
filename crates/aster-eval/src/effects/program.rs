mod catalog;
mod kernels;
include!("program/modules.rs");

use super::EffectTrack;
use crate::EvaluationError;
use catalog::EffectCatalog;
use kernels::EffectKernels;
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectProgram {
    pub data: Vec<f32>,
    pub count: usize,
    pub uses_blur: bool,
    pub uses_glow: bool,
    pub glow_threshold: f64,
}

impl EffectProgram {
    /// Layers arrive in composition order; operations follow back-to-front render order.
    pub fn compile(
        layers: &[Vec<EffectTrack>],
        time: f64,
        pixel_scale: f64,
    ) -> Result<Self, EvaluationError> {
        Self::compile_slices(
            &layers.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            time,
            pixel_scale,
        )
    }

    pub(crate) fn compile_slices(
        layers: &[&[EffectTrack]],
        time: f64,
        pixel_scale: f64,
    ) -> Result<Self, EvaluationError> {
        if !time.is_finite() || !pixel_scale.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let mut program = Self {
            data: vec![0.0; 64 * 16],
            count: 0,
            uses_blur: false,
            uses_glow: false,
            glow_threshold: 0.0,
        };
        for layer in layers.iter().rev() {
            for effect in *layer {
                if !effect.enabled {
                    continue;
                }
                let Some(pixels) = EffectCatalog::pixels(&effect.effect_type) else {
                    continue;
                };
                let mut frame = effect.evaluate(time)?;
                frame.scale_pixels(&pixels, pixel_scale)?;
                let operation = EffectKernels::operation(&effect.effect_type, &frame)
                    .ok_or(EvaluationError::Unsupported("effect operation family"))?;
                if let Some(mask) = &effect.mask {
                    let mut operation = [0.0; 16];
                    operation[0] = 106.0;
                    for (out, value) in operation[1..9].iter_mut().zip(mask.uniforms(pixel_scale)?)
                    {
                        *out = f64::from(value);
                    }
                    program.emit(operation)?;
                }
                program.emit(operation)?;
                if effect.mask.is_some() {
                    let mut operation = [0.0; 16];
                    operation[0] = 107.0;
                    program.emit(operation)?;
                }
            }
        }
        for operation in program.data.chunks_exact(16).take(program.count) {
            let opcode = operation[0] as u32;
            program.uses_blur |= matches!(
                opcode,
                17 | 101
                    | 104
                    | 105
                    | 116
                    | 118
                    | 121
                    | 123
                    | 141
                    | 146
                    | 171
                    | 219
                    | 221
                    | 222
                    | 223
                    | 224
                    | 225
                    | 226
                    | 240
                    | 248
                    | 268
            );
            if opcode == 102 {
                program.uses_glow = true;
                program.glow_threshold = program.glow_threshold.max(f64::from(operation[1]));
            }
        }
        Ok(program)
    }

    fn emit(&mut self, operation: [f64; 16]) -> Result<(), EvaluationError> {
        // The fixed shared shader ABI admits exactly 64 operations, including masks.
        if self.count >= 64 {
            return Ok(());
        }
        let packed = operation.map(|v| v as f32);
        if packed.iter().any(|v| !v.is_finite()) {
            return Err(EvaluationError::InvalidProperty(
                "nonfinite effect operation".into(),
            ));
        }
        self.data[self.count * 16..(self.count + 1) * 16].copy_from_slice(&packed);
        self.count += 1;
        Ok(())
    }
}

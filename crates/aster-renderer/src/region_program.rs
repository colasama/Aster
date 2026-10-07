use aster_render_ir::Extent2d;

use crate::layer_plan::LayerPlan;

pub(crate) struct RegionProgram;

impl RegionProgram {
    /// Only bounded, alpha-local programs are admitted. Neutral base controls and bounded color
    /// parameters keep transparent pixels finite; warps and unproved sampling routes stay full-frame.
    pub fn padding(plan: &LayerPlan, size: Extent2d) -> Option<f64> {
        if plan.uniforms.len() != 96 || !plan.operations.len().is_multiple_of(64) {
            return None;
        }
        let mut uniforms = [0.0_f32; 24];
        for (value, bytes) in uniforms.iter_mut().zip(plan.uniforms.chunks_exact(4)) {
            *value = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        }
        if uniforms.iter().any(|value| !value.is_finite())
            || uniforms[0] != size.width as f32
            || uniforms[1] != size.height as f32
            || [3, 6, 7, 8, 10, 11, 12, 13, 15, 21]
                .iter()
                .any(|index| uniforms[*index] != 0.0)
            || [4, 5, 14, 17, 22]
                .iter()
                .any(|index| uniforms[*index] != 1.0)
        {
            return None;
        }
        let mut padding = 2.0_f64;
        for bytes in plan.operations.chunks_exact(64) {
            let mut op = [0.0_f32; 16];
            for (value, bytes) in op.iter_mut().zip(bytes.chunks_exact(4)) {
                *value = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            }
            if op.iter().any(|value| !value.is_finite()) {
                return None;
            }
            match op[0] {
                2.0 if (2.0..=65536.0).contains(&op[1]) => {}
                3.0 if op[1..8].iter().all(|value| (0.0..=1.0).contains(value)) => {}
                4.0 if op[1..5].iter().all(|value| (0.0..=1.0).contains(value)) => {}
                32.0 if (0.0..=1.0).contains(&op[1])
                    && op[2..9].iter().all(|value| value.abs() <= 65504.0) => {}
                132.0
                    if op[1..5].iter().all(|value| (0.0..=1.0).contains(value))
                        && (0.0..=1_000_000.0).contains(&op[5])
                        && (0.0..=1.0).contains(&op[6])
                        && (0.05..=64.0).contains(&op[7]) =>
                {
                    padding += f64::from(op[5]);
                }
                134.0
                    if op[1..5].iter().all(|value| (0.0..=1.0).contains(value))
                        && op[5].abs() <= 1_000_000.0
                        && (0.0..=2.0).contains(&op[6]) =>
                {
                    padding += f64::from(op[5].abs());
                }
                _ => return None,
            }
        }
        Some(padding)
    }
}

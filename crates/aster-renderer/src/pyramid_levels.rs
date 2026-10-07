use aster_render_ir::Extent2d;

/// Allocated mip counts, including a guard level for fractional LOD sampling.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct PyramidLevels {
    pub blur: u32,
    pub glow: u32,
}

impl PyramidLevels {
    pub fn full_count(size: Extent2d) -> u32 {
        let width = size.width.div_ceil(2).max(1);
        let height = size.height.div_ceil(2).max(1);
        (width.max(height).ilog2() + 1).min(8)
    }

    pub fn for_program(
        size: Extent2d,
        operations: &[u8],
        uses_blur: bool,
        uses_glow: bool,
    ) -> Self {
        let full = Self::full_count(size);
        if !operations.len().is_multiple_of(64) {
            return Self {
                blur: if uses_blur { full } else { 0 },
                glow: if uses_glow { full } else { 0 },
            };
        }
        let mut blur_radius = 0.0_f32;
        let mut glow_radius = 0.0_f32;
        for operation in operations.chunks_exact(64) {
            let mut lanes = [0.0_f32; 16];
            for (value, bytes) in lanes.iter_mut().zip(operation.chunks_exact(4)) {
                *value = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
            }
            // Malformed or future programs retain the full pyramid instead of guessing a bound.
            if lanes.iter().any(|value| !value.is_finite())
                || lanes[0].fract() != 0.0
                || !(1.0..=268.0).contains(&lanes[0])
            {
                return Self {
                    blur: if uses_blur { full } else { 0 },
                    glow: if uses_glow { full } else { 0 },
                };
            }
            let radius = match lanes[0] as u32 {
                17 | 248 => lanes[2],
                101 => lanes[1] * if lanes[2] > 0.5 { 0.72 } else { 1.0 },
                102 => {
                    glow_radius = glow_radius.max(lanes[2]);
                    // Preserve the unmasked shader branch if the supplied glow flag is absent.
                    lanes[2]
                }
                104 => (lanes[14] * 18.0).max(0.5),
                105 => (lanes[4] * 28.0).max(0.5),
                116 => lanes[1].max(lanes[2]).max(lanes[3]),
                118 | 121 | 123 | 141 | 146 | 171 | 221..=226 | 240 => lanes[1],
                219 => (lanes[1] * 0.5).max(0.5),
                // Bokeh's absolute CoC is bounded by radius * abs(sign). Its 0.3 LOD
                // scale is smaller than the common 1/3 scale used below.
                268 => lanes[1].max(0.0) * lanes[3].abs(),
                _ => 0.0,
            };
            blur_radius = blur_radius.max(radius);
        }
        let count = |enabled: bool, radius: f32| {
            if !enabled {
                0
            } else if !radius.is_finite() {
                full
            } else {
                // Keep an extra level beyond ceil(LOD) for interpolation and GPU log2
                // rounding at boundaries. Supplied max-LOD uniforms remain unchanged.
                let lod = (f64::from(radius.max(1.0)) / 3.0).log2().max(0.0);
                (lod.ceil() as u32).saturating_add(2).min(full)
            }
        };
        Self {
            blur: count(uses_blur, blur_radius),
            glow: count(uses_glow, glow_radius),
        }
    }

    pub fn union(self, other: Self) -> Self {
        Self {
            blur: self.blur.max(other.blur),
            glow: self.glow.max(other.glow),
        }
    }
}

#[cfg(test)]
#[path = "pyramid_levels_tests.rs"]
mod tests;

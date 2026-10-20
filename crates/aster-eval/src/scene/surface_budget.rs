use super::PrecompositionSurface;
use crate::EvaluationError;
use aster_types::editor::Composition;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, clap::Args)]
pub struct SurfaceLimits {
    #[arg(long, default_value_t=Self::default().max_surface_depth)]
    pub max_surface_depth: usize,
    #[arg(long, default_value_t=Self::default().max_surfaces)]
    pub max_surfaces: usize,
    #[arg(long, default_value_t=Self::default().max_surface_textures)]
    pub max_surface_textures: usize,
    #[arg(long, default_value_t=Self::default().max_surface_pixels)]
    pub max_surface_pixels: u64,
    #[arg(long, default_value_t=Self::default().max_surface_bytes)]
    pub max_surface_bytes: u64,
    #[arg(long, default_value_t=Self::default().max_surface_dimension)]
    pub max_surface_dimension: u32,
}
impl Default for SurfaceLimits {
    fn default() -> Self {
        Self {
            max_surface_depth: 4,
            max_surfaces: 10,
            max_surface_textures: 20,
            max_surface_pixels: 8_388_608,
            max_surface_bytes: 256 * 1024 * 1024,
            max_surface_dimension: 4096,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceRequest {
    pub revision: u64,
    pub max_texture_dimension: u32,
    pub memory_budget_mb: Option<f64>,
    pub render_scale: f64,
}

#[derive(Clone, Default, Debug, Serialize)]
pub struct SurfaceBudget {
    pub surfaces: usize,
    pub textures: usize,
    pub pixels: u64,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceTarget {
    pub id: String,
    pub width: u32,
    pub height: u32,
    pub estimated_bytes: u64,
    pub texture_count: usize,
    pub has_effects: bool,
}

pub(super) struct SurfaceDecision {
    pub target: Option<SurfaceTarget>,
    pub diagnostic: Option<String>,
    pub downgraded: bool,
}

impl SurfaceBudget {
    pub(super) fn allocate(
        &mut self,
        composition: &Composition,
        surface: &PrecompositionSurface,
        effects: bool,
        request: &SurfaceRequest,
        limits: &SurfaceLimits,
    ) -> Result<SurfaceDecision, EvaluationError> {
        let textures = if effects { 5 } else { 2 };
        let skip = if surface.composition_path.contains(&composition.id) {
            Some(format!(
                "cycle detected at composition {}",
                composition.name
            ))
        } else if surface.composition_path.len() > limits.max_surface_depth {
            Some(format!(
                "nesting exceeds depth {}",
                limits.max_surface_depth
            ))
        } else if self.surfaces >= limits.max_surfaces {
            Some(format!("surface count exceeds {}", limits.max_surfaces))
        } else if self.textures + textures > limits.max_surface_textures {
            Some(format!(
                "texture count exceeds {}",
                limits.max_surface_textures
            ))
        } else {
            None
        };
        if let Some(diagnostic) = skip {
            return Ok(SurfaceDecision {
                target: None,
                diagnostic: Some(diagnostic),
                downgraded: false,
            });
        }
        let bytes_per_pixel = if effects { 38.0 } else { 12.0 };
        let scale = request.render_scale;
        let byte_limit = request
            .memory_budget_mb
            .map_or(128.0, |mb| (mb * 0.35).max(1.0))
            * 1024.0
            * 1024.0;
        let byte_limit = if scale > 1.0 {
            byte_limit
        } else {
            byte_limit.min(limits.max_surface_bytes as f64)
        };
        let remaining_pixels = ((limits.max_surface_pixels as f64 * scale.powi(2)
            - self.pixels as f64)
            .min((byte_limit - self.bytes as f64) / bytes_per_pixel))
        .floor()
        .max(0.0);
        if remaining_pixels < 256.0 {
            return Ok(SurfaceDecision {
                target: None,
                diagnostic: Some("pixel or VRAM budget is exhausted".into()),
                downgraded: false,
            });
        }
        let dimension_limit = f64::from(request.max_texture_dimension)
            .min(f64::from(limits.max_surface_dimension) * scale)
            .max(1.0);
        let source_width = composition
            .width
            .as_f64()
            .ok_or_else(|| EvaluationError::InvalidScene("invalid surface width".into()))?
            * scale;
        let source_height = composition
            .height
            .as_f64()
            .ok_or_else(|| EvaluationError::InvalidScene("invalid surface height".into()))?
            * scale;
        let factor = 1.0_f64
            .min(dimension_limit / source_width)
            .min(dimension_limit / source_height)
            .min((remaining_pixels / (source_width * source_height)).sqrt());
        let width = (source_width * factor).floor().max(1.0) as u32;
        let height = (source_height * factor).floor().max(1.0) as u32;
        let pixels = u64::from(width) * u64::from(height);
        let estimated_bytes = pixels * bytes_per_pixel as u64;
        let downgraded = f64::from(width) != source_width || f64::from(height) != source_height;
        self.surfaces += 1;
        self.textures += textures;
        self.pixels += pixels;
        self.bytes += estimated_bytes;
        Ok(SurfaceDecision {
            target: Some(SurfaceTarget {
                id: format!(
                    "{}:{}:{}:{}x{}",
                    request.revision,
                    composition.id,
                    SurfaceKey::time(surface.time)?,
                    width,
                    height
                ),
                width,
                height,
                estimated_bytes,
                texture_count: textures,
                has_effects: effects,
            }),
            diagnostic: downgraded.then(|| {
                format!(
                    "{} surface scaled {}x{} -> {}x{}",
                    composition.name, source_width, source_height, width, height
                )
            }),
            downgraded,
        })
    }
}

pub(super) struct SurfaceKey;
impl SurfaceKey {
    /// Decimal rounding operates on the exact binary value, avoiding double rounding at 1e-9.
    pub(super) fn time(time: f64) -> Result<String, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        if time.abs() >= 1e21 {
            return Ok(format!("{time:e}").replace('e', "e+"));
        }
        let bits = time.abs().to_bits();
        let exponent = ((bits >> 52) & 0x7ff) as i32;
        let fraction = bits & ((1_u64 << 52) - 1);
        let significand = if exponent == 0 {
            fraction
        } else {
            fraction | (1_u64 << 52)
        };
        let shift = if exponent == 0 {
            -1074
        } else {
            exponent - 1075
        } + 9;
        let scaled = u128::from(significand) * 5_u128.pow(9);
        let rounded = if shift >= 0 {
            scaled << shift
        } else {
            let right = (-shift) as u32;
            if right >= 128 {
                0
            } else {
                let truncated = scaled >> right;
                let remainder = scaled - (truncated << right);
                truncated + u128::from(remainder >= (1_u128 << (right - 1)))
            }
        };
        Ok(format!(
            "{}{}.{:09}",
            if time < 0.0 { "-" } else { "" },
            rounded / 1_000_000_000,
            rounded % 1_000_000_000
        ))
    }
}

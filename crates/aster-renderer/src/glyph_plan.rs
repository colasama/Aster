use aster_render_ir::{Extent2d, ResourceHash};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{GlyphTextAtlas, RenderError};

/// A draw selects a raster variant (fill or stroke) and applies its evaluated style in order.
/// Baseline coordinates exclude the fractional phase already baked into the glyph image.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlyphTextDraw {
    pub placement: usize,
    pub baseline: [f32; 2],
    pub transform: [f32; 6],
    pub color: [f32; 4],
    pub clip: [u32; 4],
}

/// Internal native composition input, independent of project serialization and frame-plan ABI.
pub struct GlyphTextPlan {
    pub size: Extent2d,
    pub draws: Vec<GlyphTextDraw>,
}

impl GlyphTextPlan {
    pub fn required_bytes(&self) -> Result<u64, RenderError> {
        u64::from(self.size.width)
            .checked_mul(u64::from(self.size.height))
            .and_then(|n| n.checked_mul(8))
            .and_then(|n| n.checked_add((self.draws.len() as u64).checked_mul(256)?))
            .ok_or_else(|| RenderError::Invalid("glyph output byte overflow".into()))
    }

    pub(crate) fn validate(
        &self,
        device: &wgpu::Device,
        atlas: &GlyphTextAtlas,
        budget: u64,
    ) -> Result<ResourceHash, RenderError> {
        if self.size.width == 0
            || self.size.height == 0
            || self.size.width > device.limits().max_texture_dimension_2d
            || self.size.height > device.limits().max_texture_dimension_2d
            || self.draws.len() > atlas.config.max_glyph_draws
            || self.required_bytes()? > budget
            || self.draws.len() as u64 * 256 > device.limits().max_buffer_size
        {
            return Err(RenderError::Invalid("glyph output budget or extent".into()));
        }
        for draw in &self.draws {
            if draw.placement >= atlas.generation.placements.len()
                || draw
                    .baseline
                    .iter()
                    .chain(&draw.transform)
                    .any(|n| !n.is_finite() || n.abs() > 1_048_576.0)
                || draw
                    .color
                    .iter()
                    .any(|n| !n.is_finite() || !(0.0..=1.0).contains(n))
                || draw.clip[0]
                    .checked_add(draw.clip[2])
                    .is_none_or(|n| n > self.size.width)
                || draw.clip[1]
                    .checked_add(draw.clip[3])
                    .is_none_or(|n| n > self.size.height)
            {
                return Err(RenderError::Invalid(
                    "glyph draw index, transform, color or clip".into(),
                ));
            }
        }
        let mut hash = Sha256::new();
        hash.update(b"aster.gpu-glyph-output.v1");
        hash.update(atlas.identity.0.as_bytes());
        hash.update(self.size.width.to_le_bytes());
        hash.update(self.size.height.to_le_bytes());
        hash.update(
            serde_json::to_vec(&self.draws).map_err(|e| RenderError::Invalid(e.to_string()))?,
        );
        Ok(ResourceHash(format!("{:x}", hash.finalize())))
    }
}

use std::sync::Arc;

use aster_render_ir::ResourceHash;
use aster_text::{GlyphGeneration, GlyphImageFormat};
use sha2::{Digest, Sha256};

use crate::RenderError;

#[derive(Clone, Debug, clap::Args)]
pub struct GlyphTextConfig {
    #[arg(long, default_value_t = 65_536)]
    pub max_glyph_draws: usize,
    #[arg(long, default_value_t = 64)]
    pub max_gpu_glyph_pages: usize,
}

impl Default for GlyphTextConfig {
    fn default() -> Self {
        Self {
            max_glyph_draws: 65_536,
            max_gpu_glyph_pages: 64,
        }
    }
}

/// GPU pages and their immutable CPU coordinates share one lease. Prepared passes retain it.
pub struct GlyphTextAtlas {
    pub identity: ResourceHash,
    pub bytes: u64,
    pub(crate) generation: Arc<GlyphGeneration>,
    pub(crate) pages: Vec<wgpu::Texture>,
    pub(crate) config: GlyphTextConfig,
}

impl GlyphTextAtlas {
    pub(crate) fn validate(
        generation: &GlyphGeneration,
        config: &GlyphTextConfig,
        max_dimension: u32,
        budget: u64,
    ) -> Result<(ResourceHash, u64), RenderError> {
        if config.max_glyph_draws == 0
            || config.max_glyph_draws > 65_536
            || config.max_gpu_glyph_pages == 0
            || config.max_gpu_glyph_pages > 64
            || generation.pages.len() > config.max_gpu_glyph_pages
            || generation.placements.len() > 65_536
        {
            return Err(RenderError::Invalid(
                "GPU glyph configuration or count".into(),
            ));
        }
        let mut bytes = 0_u64;
        let mut hash = Sha256::new();
        hash.update(b"aster.gpu-glyph-atlas.v1");
        hash.update(
            serde_json::to_vec(&generation.placements)
                .map_err(|e| RenderError::Invalid(e.to_string()))?,
        );
        for page in &generation.pages {
            let channels = match page.format {
                GlyphImageFormat::Coverage => 1,
                GlyphImageFormat::PremultipliedSrgbRgba => 4,
            };
            let length = u64::from(page.dimension) * u64::from(page.dimension) * channels;
            if page.dimension == 0
                || page.dimension > 4096
                || page.dimension > max_dimension
                || u64::from(page.bytes_per_row) != u64::from(page.dimension) * channels
                || page.data.len() as u64 != length
                || (channels == 4
                    && page
                        .data
                        .chunks_exact(4)
                        .any(|p| p[..3].iter().any(|c| *c > p[3])))
            {
                return Err(RenderError::Invalid(
                    "glyph page extent, format or bytes".into(),
                ));
            }
            bytes = bytes
                .checked_add(length)
                .filter(|n| *n <= budget)
                .ok_or_else(|| RenderError::Invalid("GPU glyph atlas budget".into()))?;
            hash.update(page.dimension.to_le_bytes());
            hash.update(channels.to_le_bytes());
            hash.update(&page.data);
        }
        if bytes != generation.bytes as u64 {
            return Err(RenderError::Invalid(
                "glyph generation byte accounting".into(),
            ));
        }
        for glyph in &generation.placements {
            let [x, y, width, height] = glyph.rect;
            if !glyph.nominal_advance.is_finite() {
                return Err(RenderError::Invalid("glyph nominal advance".into()));
            }
            if let Some(index) = glyph.page {
                let page = generation
                    .pages
                    .get(index)
                    .ok_or_else(|| RenderError::Invalid("glyph page index".into()))?;
                if x == 0
                    || y == 0
                    || width == 0
                    || height == 0
                    || x.checked_add(width).is_none_or(|n| n >= page.dimension)
                    || y.checked_add(height).is_none_or(|n| n >= page.dimension)
                {
                    return Err(RenderError::Invalid("glyph padded rectangle".into()));
                }
            } else if width != 0 || height != 0 {
                return Err(RenderError::Invalid("nonempty glyph has no page".into()));
            }
        }
        // Hash actual page bytes and coordinates, rather than trusting a caller-supplied identity.
        let identity = ResourceHash(format!("{:x}", hash.finalize()));
        Ok((identity, bytes))
    }

    pub fn upload(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        generation: Arc<GlyphGeneration>,
        config: GlyphTextConfig,
        budget: u64,
    ) -> Result<Arc<Self>, RenderError> {
        let (identity, bytes) = Self::validate(
            &generation,
            &config,
            device.limits().max_texture_dimension_2d,
            budget,
        )?;
        let mut pages = Vec::with_capacity(generation.pages.len());
        for page in &generation.pages {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("Immutable native glyph atlas"),
                size: wgpu::Extent3d {
                    width: page.dimension,
                    height: page.dimension,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: match page.format {
                    GlyphImageFormat::Coverage => wgpu::TextureFormat::R8Unorm,
                    GlyphImageFormat::PremultipliedSrgbRgba => wgpu::TextureFormat::Rgba8Unorm,
                },
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });
            queue.write_texture(
                texture.as_image_copy(),
                &page.data,
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(page.bytes_per_row),
                    rows_per_image: Some(page.dimension),
                },
                texture.size(),
            );
            pages.push(texture);
        }
        Ok(Arc::new(Self {
            identity,
            bytes,
            generation,
            pages,
            config,
        }))
    }
}

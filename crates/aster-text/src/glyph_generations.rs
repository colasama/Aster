use std::{collections::BTreeMap, sync::Arc};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{GlyphImage, GlyphImageFormat, GlyphRasterConfig, GlyphRasterError, GlyphRasterKey};

#[derive(Clone, Debug, clap::Args)]
pub struct GlyphGenerationConfig {
    #[arg(long, default_value_t = 1024)]
    pub glyph_page_dimension: u32,
    #[arg(long, default_value_t = 16)]
    pub max_glyph_pages: usize,
    #[arg(long, default_value_t = 8)]
    pub max_glyph_generations: usize,
    #[arg(long, default_value_t = 256 * 1024 * 1024)]
    pub glyph_generation_bytes: usize,
    #[arg(long, default_value_t = 16_384)]
    pub max_generation_glyphs: usize,
}

impl Default for GlyphGenerationConfig {
    fn default() -> Self {
        Self {
            glyph_page_dimension: 1024,
            max_glyph_pages: 16,
            max_glyph_generations: 8,
            glyph_generation_bytes: 256 * 1024 * 1024,
            max_generation_glyphs: 16_384,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GlyphPlacement {
    pub key: GlyphRasterKey,
    pub page: Option<usize>,
    pub rect: [u32; 4],
    pub origin: [i32; 2],
    pub nominal_advance: f32,
}

#[derive(Debug)]
pub struct GlyphPage {
    pub format: GlyphImageFormat,
    pub dimension: u32,
    pub bytes_per_row: u32,
    pub data: Vec<u8>,
}

/// Immutable upload data and coordinates. Retain the Arc until every GPU frame using it retires.
#[derive(Debug)]
pub struct GlyphGeneration {
    pub identity: [u8; 32],
    pub placements: Vec<GlyphPlacement>,
    pub pages: Vec<GlyphPage>,
    pub bytes: usize,
}

struct PagePlan {
    format: GlyphImageFormat,
    x: u32,
    y: u32,
    row_height: u32,
}

pub struct GlyphGenerations {
    config: GlyphGenerationConfig,
    cache: BTreeMap<[u8; 32], (u64, Arc<GlyphGeneration>)>,
    bytes: usize,
    clock: u64,
}

impl GlyphGenerations {
    pub fn new(config: GlyphGenerationConfig) -> Result<Self, GlyphRasterError> {
        if !(256..=4096).contains(&config.glyph_page_dimension)
            || !config.glyph_page_dimension.is_power_of_two()
            || config.max_glyph_pages == 0
            || config.max_glyph_pages > 64
            || config.max_glyph_generations == 0
            || config.max_glyph_generations > 64
            || config.glyph_generation_bytes == 0
            || config.glyph_generation_bytes > 512 * 1024 * 1024
            || config.max_generation_glyphs == 0
            || config.max_generation_glyphs > 65_536
        {
            return Err(GlyphRasterError::Invalid("glyph generation budgets"));
        }
        Ok(Self {
            config,
            cache: BTreeMap::new(),
            bytes: 0,
            clock: 0,
        })
    }

    pub fn prepare(
        &mut self,
        images: &[Arc<GlyphImage>],
    ) -> Result<Arc<GlyphGeneration>, GlyphRasterError> {
        if images.len() > self.config.max_generation_glyphs {
            return Err(GlyphRasterError::Limit("generation glyph count"));
        }
        let mut unique = BTreeMap::new();
        let mut input_bytes = 0_usize;
        let mut hash = Sha256::new();
        hash.update(b"aster.glyph-atlas.v1");
        hash.update(self.config.glyph_page_dimension.to_le_bytes());
        let validation = GlyphRasterConfig {
            max_glyph_dimension: 4096,
            max_glyph_bytes: 64 * 1024 * 1024,
            ..Default::default()
        };
        for image in images {
            image.validate(&validation)?;
            input_bytes = input_bytes
                .checked_add(image.data.len())
                .filter(|n| *n <= self.config.glyph_generation_bytes)
                .ok_or(GlyphRasterError::Limit("generation input bytes"))?;
            if let Some(prior) = unique.insert(&image.key, image)
                && (prior.data != image.data
                    || prior.format != image.format
                    || prior.origin != image.origin
                    || prior.width != image.width
                    || prior.height != image.height
                    || prior.nominal_advance != image.nominal_advance)
            {
                return Err(GlyphRasterError::Invalid(
                    "same glyph key has different raster content",
                ));
            }
        }
        for image in unique.values() {
            let metadata = serde_json::to_vec(&(
                &image.key,
                image.format,
                image.width,
                image.height,
                image.origin,
                image.nominal_advance.to_bits(),
            ))
            .map_err(|_| GlyphRasterError::Invalid("glyph identity encoding"))?;
            hash.update((metadata.len() as u64).to_le_bytes());
            hash.update(metadata);
            hash.update(Sha256::digest(&image.data));
        }
        let identity: [u8; 32] = hash.finalize().into();
        self.clock = self
            .clock
            .checked_add(1)
            .ok_or(GlyphRasterError::Limit("generation clock"))?;
        if let Some((tick, generation)) = self.cache.get_mut(&identity) {
            *tick = self.clock;
            return Ok(Arc::clone(generation));
        }
        let dimension = self.config.glyph_page_dimension;
        let mut pages: Vec<PagePlan> = Vec::new();
        let mut placements = Vec::with_capacity(unique.len());
        for image in unique.values() {
            let mut placement = GlyphPlacement {
                key: image.key.clone(),
                page: None,
                rect: [0, 0, image.width, image.height],
                origin: image.origin,
                nominal_advance: image.nominal_advance,
            };
            if image.width == 0 {
                placements.push(placement);
                continue;
            }
            let width = image.width + 2;
            let height = image.height + 2;
            if width > dimension || height > dimension {
                return Err(GlyphRasterError::Limit("glyph exceeds atlas page"));
            }
            let mut selected = None;
            for (index, page) in pages
                .iter_mut()
                .enumerate()
                .filter(|(_, p)| p.format == image.format)
            {
                let new_row = page.x + width > dimension;
                let y = if new_row {
                    page.y + page.row_height
                } else {
                    page.y
                };
                if y + height <= dimension {
                    if new_row {
                        page.x = 0;
                        page.y = y;
                        page.row_height = 0;
                    }
                    selected = Some(index);
                    break;
                }
            }
            let index = match selected {
                Some(index) => index,
                None => {
                    if pages.len() >= self.config.max_glyph_pages {
                        return Err(GlyphRasterError::Limit("glyph atlas pages"));
                    }
                    pages.push(PagePlan {
                        format: image.format,
                        x: 0,
                        y: 0,
                        row_height: 0,
                    });
                    pages.len() - 1
                }
            };
            let page = &mut pages[index];
            placement.page = Some(index);
            placement.rect[0] = page.x + 1;
            placement.rect[1] = page.y + 1;
            page.x += width;
            page.row_height = page.row_height.max(height);
            placements.push(placement);
        }
        let bytes = pages.iter().try_fold(0_usize, |total, page| {
            total
                .checked_add(dimension as usize * dimension as usize * page.format.channels())
                .filter(|n| *n <= self.config.glyph_generation_bytes)
                .ok_or(GlyphRasterError::Limit("glyph atlas bytes"))
        })?;
        while self.cache.len() >= self.config.max_glyph_generations
            || self.bytes > self.config.glyph_generation_bytes - bytes
        {
            let victim = self
                .cache
                .iter()
                .filter(|(_, (_, generation))| Arc::strong_count(generation) == 1)
                .min_by_key(|(_, (tick, _))| *tick)
                .map(|(key, _)| *key)
                .ok_or(GlyphRasterError::Limit("all glyph generations are leased"))?;
            if let Some((_, generation)) = self.cache.remove(&victim) {
                self.bytes -= generation.bytes;
            }
        }
        let mut pages: Vec<_> = pages
            .into_iter()
            .map(|p| GlyphPage {
                format: p.format,
                dimension,
                bytes_per_row: dimension * p.format.channels() as u32,
                data: vec![0; dimension as usize * dimension as usize * p.format.channels()],
            })
            .collect();
        for (image, placement) in unique.values().zip(&placements) {
            if let Some(index) = placement.page {
                let page = &mut pages[index];
                let channels = page.format.channels();
                let row_bytes = image.width as usize * channels;
                for y in 0..image.height as usize {
                    let target = (placement.rect[1] as usize + y) * page.bytes_per_row as usize
                        + placement.rect[0] as usize * channels;
                    page.data[target..target + row_bytes]
                        .copy_from_slice(&image.data[y * row_bytes..(y + 1) * row_bytes]);
                }
            }
        }
        let generation = Arc::new(GlyphGeneration {
            identity,
            placements,
            pages,
            bytes,
        });
        self.bytes += bytes;
        self.cache
            .insert(identity, (self.clock, Arc::clone(&generation)));
        Ok(generation)
    }
}

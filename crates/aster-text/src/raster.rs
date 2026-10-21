use std::{collections::BTreeMap, sync::Arc};

use serde::{Deserialize, Serialize};
use skrifa::{FontRef, MetadataProvider, instance::Size, raw::types::GlyphId};
use thiserror::Error;

use crate::{FontFaceId, NativeFont, raster_bitmap::BitmapRaster, raster_outline::OutlineRaster};

#[derive(Clone, Debug, clap::Args)]
pub struct GlyphRasterConfig {
    #[arg(long, default_value_t = 2048)]
    pub max_glyph_dimension: u32,
    #[arg(long, default_value_t = 16 * 1024 * 1024)]
    pub max_glyph_bytes: usize,
    #[arg(long, default_value_t = 65_536)]
    pub max_outline_commands: usize,
    #[arg(long, default_value_t = 8 * 1024 * 1024)]
    pub max_outline_scratch: usize,
    #[arg(long, default_value_t = 64 * 1024 * 1024)]
    pub glyph_cache_bytes: usize,
    #[arg(long, default_value_t = 16_384)]
    pub glyph_cache_entries: usize,
}

impl Default for GlyphRasterConfig {
    fn default() -> Self {
        Self {
            max_glyph_dimension: 2048,
            max_glyph_bytes: 16 * 1024 * 1024,
            max_outline_commands: 65_536,
            max_outline_scratch: 8 * 1024 * 1024,
            glyph_cache_bytes: 64 * 1024 * 1024,
            glyph_cache_entries: 16_384,
        }
    }
}

impl GlyphRasterConfig {
    pub(crate) fn image_bytes(
        &self,
        width: u32,
        height: u32,
        channels: usize,
    ) -> Result<usize, GlyphRasterError> {
        if width > self.max_glyph_dimension || height > self.max_glyph_dimension {
            return Err(GlyphRasterError::Limit("glyph dimensions"));
        }
        (width as usize)
            .checked_mul(height as usize)
            .and_then(|n| n.checked_mul(channels))
            .filter(|n| *n <= self.max_glyph_bytes)
            .ok_or(GlyphRasterError::Limit("glyph image bytes"))
    }
}

#[derive(Debug, Error)]
pub enum GlyphRasterError {
    #[error("glyph raster limit exceeded: {0}")]
    Limit(&'static str),
    #[error("invalid glyph raster: {0}")]
    Invalid(&'static str),
    #[error("glyph raster requires retained rendering: {0}")]
    Unsupported(&'static str),
    #[error("glyph outline failed: {0}")]
    Outline(#[from] skrifa::outline::DrawError),
    #[error("glyph PNG failed: {0}")]
    Png(#[from] png::DecodingError),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlyphHinting {
    #[default]
    None,
    Vertical,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GlyphPaint {
    Fill,
    Stroke { width: f32 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GlyphRasterRequest {
    pub glyph_id: u32,
    pub size: f32,
    /// Fractional baseline position in screen coordinates; integer translation stays in the draw.
    pub phase: [f32; 2],
    pub hinting: GlyphHinting,
    pub paint: GlyphPaint,
    pub foreground: [u8; 4],
    pub prefer_bitmap: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct GlyphRasterKey {
    pub face: FontFaceId,
    pub variations: Vec<([u8; 4], u32)>,
    pub glyph_id: u32,
    pub size_bits: u32,
    pub phase_bits: [u32; 2],
    pub hinting: GlyphHinting,
    pub stroke_bits: Option<u32>,
    pub foreground: [u8; 4],
    pub prefer_bitmap: bool,
}

impl GlyphRasterRequest {
    pub fn key(&self, font: &NativeFont) -> Result<GlyphRasterKey, GlyphRasterError> {
        if !self.size.is_finite()
            || self.size <= 0.0
            || self.size > 4096.0
            || self
                .phase
                .iter()
                .any(|v| !v.is_finite() || !(0.0..1.0).contains(v))
            || self.glyph_id >= font.font.num_glyphs()
        {
            return Err(GlyphRasterError::Invalid(
                "glyph id, size or fractional phase",
            ));
        }
        let stroke_bits = match self.paint {
            GlyphPaint::Fill => None,
            GlyphPaint::Stroke { width } if width.is_finite() && width > 0.0 && width <= 256.0 => {
                Some(width.to_bits())
            }
            _ => return Err(GlyphRasterError::Invalid("stroke width")),
        };
        Ok(GlyphRasterKey {
            face: font.selection.face,
            variations: font
                .selection
                .variations
                .iter()
                .map(|(tag, v)| (*tag, v.to_bits()))
                .collect(),
            glyph_id: self.glyph_id,
            size_bits: self.size.to_bits(),
            phase_bits: self.phase.map(|v| if v == 0.0 { 0 } else { v.to_bits() }),
            hinting: self.hinting,
            stroke_bits,
            foreground: self.foreground,
            prefer_bitmap: self.prefer_bitmap,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GlyphImageFormat {
    Coverage,
    PremultipliedSrgbRgba,
}

impl GlyphImageFormat {
    pub fn channels(self) -> usize {
        match self {
            Self::Coverage => 1,
            Self::PremultipliedSrgbRgba => 4,
        }
    }
}

#[derive(Clone, Debug)]
pub struct GlyphImage {
    pub key: GlyphRasterKey,
    pub format: GlyphImageFormat,
    pub width: u32,
    pub height: u32,
    /// Top-left corner relative to the integer baseline, in screen coordinates.
    pub origin: [i32; 2],
    /// Unhinted nominal advance; positioned draws must retain the shaper's contextual advance.
    pub nominal_advance: f32,
    pub data: Vec<u8>,
}

impl GlyphImage {
    pub fn validate(&self, config: &GlyphRasterConfig) -> Result<(), GlyphRasterError> {
        let expected = config.image_bytes(self.width, self.height, self.format.channels())?;
        if self.data.len() != expected
            || !self.nominal_advance.is_finite()
            || (self.width == 0) != (self.height == 0)
        {
            return Err(GlyphRasterError::Invalid(
                "glyph image dimensions, metrics or bytes",
            ));
        }
        if self.format == GlyphImageFormat::PremultipliedSrgbRgba
            && self
                .data
                .chunks_exact(4)
                .any(|p| p[..3].iter().any(|c| *c > p[3]))
        {
            return Err(GlyphRasterError::Invalid("non-premultiplied glyph color"));
        }
        Ok(())
    }
}

pub struct GlyphRasterizer {
    config: GlyphRasterConfig,
    cache: BTreeMap<GlyphRasterKey, (u64, Arc<GlyphImage>)>,
    bytes: usize,
    clock: u64,
}

impl GlyphRasterizer {
    pub fn new(config: GlyphRasterConfig) -> Result<Self, GlyphRasterError> {
        if config.max_glyph_dimension == 0
            || config.max_glyph_dimension > 4096
            || config.max_glyph_bytes == 0
            || config.max_glyph_bytes > 64 * 1024 * 1024
            || config.max_outline_commands == 0
            || config.max_outline_commands > 262_144
            || config.max_outline_scratch == 0
            || config.max_outline_scratch > 64 * 1024 * 1024
            || config.glyph_cache_bytes < config.max_glyph_bytes
            || config.glyph_cache_bytes > 512 * 1024 * 1024
            || config.glyph_cache_entries == 0
            || config.glyph_cache_entries > 65_536
        {
            return Err(GlyphRasterError::Invalid("raster budgets"));
        }
        Ok(Self {
            config,
            cache: BTreeMap::new(),
            bytes: 0,
            clock: 0,
        })
    }

    pub fn rasterize(
        &mut self,
        font: &NativeFont,
        request: &GlyphRasterRequest,
    ) -> Result<Arc<GlyphImage>, GlyphRasterError> {
        let key = request.key(font)?;
        self.clock = self
            .clock
            .checked_add(1)
            .ok_or(GlyphRasterError::Limit("cache clock"))?;
        if let Some((tick, image)) = self.cache.get_mut(&key) {
            *tick = self.clock;
            return Ok(Arc::clone(image));
        }
        // Reserve worst-case image space before rasterization. Outstanding image leases count
        // against the same budget and cannot be made invisible by removing cache entries.
        while self.cache.len() >= self.config.glyph_cache_entries
            || self.bytes > self.config.glyph_cache_bytes - self.config.max_glyph_bytes
        {
            let victim = self
                .cache
                .iter()
                .filter(|(_, (_, image))| Arc::strong_count(image) == 1)
                .min_by_key(|(_, (tick, _))| *tick)
                .map(|(key, _)| key.clone())
                .ok_or(GlyphRasterError::Limit(
                    "all glyph cache entries are leased",
                ))?;
            if let Some((_, image)) = self.cache.remove(&victim) {
                self.bytes -= image.data.len();
            }
        }
        let face = FontRef::from_index(&font.data, font.selection.face.index)
            .map_err(|_| GlyphRasterError::Invalid("physical font face"))?;
        let glyph = GlyphId::new(request.glyph_id);
        let location = face.axes().location(
            font.selection
                .variations
                .iter()
                .map(|(tag, value)| (skrifa::raw::types::Tag::new(tag), *value)),
        );
        let advance = face
            .glyph_metrics(Size::new(request.size), &location)
            .advance_width(glyph)
            .ok_or(GlyphRasterError::Invalid("glyph advance"))?;
        let mut image = GlyphImage {
            key: key.clone(),
            format: GlyphImageFormat::Coverage,
            width: 0,
            height: 0,
            origin: [0, 0],
            nominal_advance: advance,
            data: Vec::new(),
        };
        let bitmap = request
            .prefer_bitmap
            .then(|| {
                face.bitmap_strikes()
                    .glyph_for_size(Size::new(request.size), glyph)
            })
            .flatten();
        if let Some(bitmap) = bitmap {
            BitmapRaster::render(
                &bitmap,
                font.font.units_per_em(),
                request,
                &self.config,
                &mut image,
            )?;
        } else if face.color_glyphs().get(glyph).is_some() {
            return Err(GlyphRasterError::Unsupported(
                "layered color outlines require a verified paint graph",
            ));
        } else {
            OutlineRaster::render(&face, request, &self.config, &mut image)?;
        }
        image.validate(&self.config)?;
        self.bytes += image.data.len();
        let image = Arc::new(image);
        self.cache.insert(key, (self.clock, Arc::clone(&image)));
        Ok(image)
    }
}

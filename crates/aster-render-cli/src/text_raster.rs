use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

use aster_render_compare::{image::RgbaImage, png::PngCodec};
use aster_text::{
    GlyphGenerationConfig, GlyphGenerations, GlyphHinting, GlyphImage, GlyphImageFormat,
    GlyphPaint, GlyphPlacement, GlyphRasterConfig, GlyphRasterError, GlyphRasterKey,
    GlyphRasterRequest, GlyphRasterizer, NativeFont, ShapedText,
};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ir::IrArgs;

#[derive(Serialize)]
pub(crate) struct RasterFile {
    path: String,
    sha256: String,
    raw_sha256: String,
}

#[derive(Serialize)]
pub(crate) struct RasterGlyph {
    key: GlyphRasterKey,
    format: GlyphImageFormat,
    width: u32,
    height: u32,
    origin: [i32; 2],
    nominal_advance: f32,
    image: Option<RasterFile>,
}

#[derive(Serialize)]
pub(crate) struct RasterPage {
    format: GlyphImageFormat,
    dimension: u32,
    bytes_per_row: u32,
    image: RasterFile,
}

#[derive(Serialize)]
pub(crate) struct RasterQuery {
    id: String,
    mode: &'static str,
    glyphs: Vec<String>,
    error: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct RasterReport {
    pub glyphs: BTreeMap<String, RasterGlyph>,
    pub queries: Vec<RasterQuery>,
    generation: String,
    placements: Vec<GlyphPlacement>,
    pages: Vec<RasterPage>,
    native_pixel_acceptance: bool,
}

pub(crate) struct RasterAudit {
    rasterizer: GlyphRasterizer,
    generations: GlyphGenerations,
    images: BTreeMap<GlyphRasterKey, Arc<GlyphImage>>,
    queries: Vec<RasterQuery>,
    directory: PathBuf,
}

impl RasterAudit {
    pub fn new(
        directory: PathBuf,
        raster: GlyphRasterConfig,
        atlas: GlyphGenerationConfig,
    ) -> Result<Self, GlyphRasterError> {
        Ok(Self {
            rasterizer: GlyphRasterizer::new(raster)?,
            generations: GlyphGenerations::new(atlas)?,
            images: BTreeMap::new(),
            queries: Vec::new(),
            directory,
        })
    }

    pub fn observe(
        &mut self,
        id: &str,
        shaped: &ShapedText,
        size: f32,
        fonts: &[NativeFont],
    ) -> Result<(), Box<dyn std::error::Error>> {
        for mode in ["fill", "stroke", "hinted"] {
            if self.queries.len() >= 100_000 {
                return Err("Raster diagnostic query budget exceeded".into());
            }
            let mut query = RasterQuery {
                id: id.to_owned(),
                mode,
                glyphs: Vec::new(),
                error: None,
            };
            let mut cursor = 0.0;
            for glyph in &shaped.glyphs {
                let font = fonts
                    .iter()
                    .find(|font| font.matches_glyph(glyph))
                    .ok_or("Shaped face is outside the admitted chain")?;
                let request = GlyphRasterRequest {
                    glyph_id: glyph.glyph_id,
                    size,
                    phase: [
                        ((cursor + glyph.offset[0]) as f32).rem_euclid(1.0),
                        ((glyph.offset[1] + shaped.middle_baseline_offset) as f32).rem_euclid(1.0),
                    ],
                    hinting: if mode == "hinted" {
                        GlyphHinting::Vertical
                    } else {
                        GlyphHinting::None
                    },
                    coverage: aster_text::GlyphCoverage::Linear,
                    paint: if mode == "stroke" {
                        GlyphPaint::Stroke { width: 2.0 }
                    } else {
                        GlyphPaint::Fill
                    },
                    foreground: [255; 4],
                    prefer_bitmap: true,
                };
                cursor += glyph.advance[0];
                match self.rasterizer.rasterize(font, &request) {
                    Ok(image) => {
                        let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&image.key)?));
                        query.glyphs.push(key);
                        self.images.insert(image.key.clone(), image);
                    }
                    Err(error @ GlyphRasterError::Unsupported(_)) => {
                        query.error = Some(error.to_string());
                        break;
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            self.queries.push(query);
        }
        Ok(())
    }

    pub fn finish(mut self) -> Result<RasterReport, Box<dyn std::error::Error>> {
        let images: Vec<_> = self.images.values().cloned().collect();
        let generation = self.generations.prepare(&images)?;
        let mut glyphs = BTreeMap::new();
        for image in &images {
            let key = format!("{:x}", Sha256::digest(serde_json::to_vec(&image.key)?));
            let file = if image.width == 0 {
                None
            } else {
                Some(self.publish(
                    &format!("glyph-{key}.png"),
                    image.width,
                    image.height,
                    image.format,
                    &image.data,
                )?)
            };
            glyphs.insert(
                key,
                RasterGlyph {
                    key: image.key.clone(),
                    format: image.format,
                    width: image.width,
                    height: image.height,
                    origin: image.origin,
                    nominal_advance: image.nominal_advance,
                    image: file,
                },
            );
        }
        let mut pages = Vec::new();
        for (index, page) in generation.pages.iter().enumerate() {
            pages.push(RasterPage {
                format: page.format,
                dimension: page.dimension,
                bytes_per_row: page.bytes_per_row,
                image: self.publish(
                    &format!("page-{index}.png"),
                    page.dimension,
                    page.dimension,
                    page.format,
                    &page.data,
                )?,
            });
        }
        Ok(RasterReport {
            glyphs,
            queries: self.queries,
            generation: generation
                .identity
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            placements: generation.placements.clone(),
            pages,
            native_pixel_acceptance: false,
        })
    }

    fn publish(
        &self,
        name: &str,
        width: u32,
        height: u32,
        format: GlyphImageFormat,
        data: &[u8],
    ) -> Result<RasterFile, Box<dyn std::error::Error>> {
        // Coverage is stored in alpha; color PNG channels retain the declared premultiplied bytes.
        let pixels = match format {
            GlyphImageFormat::Coverage => data.iter().flat_map(|v| [255, 255, 255, *v]).collect(),
            GlyphImageFormat::PremultipliedSrgbRgba => data.to_vec(),
        };
        let png = PngCodec::encode(&RgbaImage::new(width, height, pixels)?)?;
        IrArgs::publish(&self.directory.join(name), &png)?;
        Ok(RasterFile {
            path: format!("glyph-rasters/{name}"),
            sha256: format!("{:x}", Sha256::digest(&png)),
            raw_sha256: format!("{:x}", Sha256::digest(data)),
        })
    }
}

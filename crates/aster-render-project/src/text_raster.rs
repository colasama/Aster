use crate::{ProjectRenderError, ProjectTextPaint, TextAffine};
use aster_render_ir::Extent2d;
use aster_renderer::{GlyphTextDraw, GlyphTextPlan};
use aster_text::{
    GlyphGeneration, GlyphGenerations, GlyphHinting, GlyphImageFormat, GlyphPaint,
    GlyphRasterError, GlyphRasterRequest, GlyphRasterizer, NativeFont,
};
use std::{collections::BTreeMap, sync::Arc};

pub(crate) struct TextRasterPreparation;

impl TextRasterPreparation {
    pub fn bounds(
        size: [f64; 2],
        font_size: f64,
        paints: &[ProjectTextPaint],
        fonts: &[NativeFont],
    ) -> Result<[f64; 4], ProjectRenderError> {
        let mut bounds = [0., 0., size[0].max(1.), size[1].max(1.)];
        for paint in paints {
            let mut ink: Option<[f64; 4]> = None;
            let mut pen = [0.; 2];
            for glyph in &paint.shaped.glyphs {
                let font = fonts
                    .iter()
                    .find(|f| f.matches_glyph(glyph))
                    .ok_or_else(|| {
                        ProjectRenderError::Invalid("glyph metric font absent".into())
                    })?;
                let mut rect = font.glyph_bounds(glyph.glyph_id, font_size as f32)?;
                if rect[0] != rect[2] || rect[1] != rect[3] {
                    for (i, value) in rect.iter_mut().enumerate() {
                        *value += pen[i % 2]
                            + glyph.offset[i % 2]
                            + if i % 2 == 1 {
                                paint.shaped.middle_baseline_offset
                            } else {
                                0.
                            };
                    }
                    if let Some(current) = &mut ink {
                        current[0] = current[0].min(rect[0]);
                        current[1] = current[1].min(rect[1]);
                        current[2] = current[2].max(rect[2]);
                        current[3] = current[3].max(rect[3]);
                    } else {
                        ink = Some(rect);
                    }
                }
                pen[0] += glyph.advance[0];
                pen[1] += glyph.advance[1];
            }
            let [l, t, r, b] = ink.unwrap_or([0.; 4]);
            let s = paint.stroke_radius;
            for point in [
                [l - s, t - s],
                [r + s, t - s],
                [l - s, b + s],
                [r + s, b + s],
            ] {
                let [x, y] = paint.transform.point(point);
                let padding = 1. + 3. * paint.blur;
                bounds[0] = bounds[0].min((x - padding).floor());
                bounds[1] = bounds[1].min((y - padding).floor());
                bounds[2] = bounds[2].max((x + padding).ceil());
                bounds[3] = bounds[3].max((y + padding).ceil());
            }
        }
        bounds[2] -= bounds[0];
        bounds[3] -= bounds[1];
        Ok(bounds)
    }

    pub fn rasterize(
        paints: &[ProjectTextPaint],
        fonts: &[NativeFont],
        font_size: f64,
        surface: ([f64; 4], Extent2d),
        raster: &mut GlyphRasterizer,
        generations: &mut GlyphGenerations,
    ) -> Result<(Arc<GlyphGeneration>, GlyphTextPlan), ProjectRenderError> {
        let (bounds, size) = surface;
        let scale = size.width as f64 / bounds[2];
        let yscale = size.height as f64 / bounds[3] / scale;
        let surface_transform = TextAffine([
            1.,
            0.,
            0.,
            yscale,
            -bounds[0] * scale,
            -bounds[1] * scale * yscale,
        ]);
        let mut images = BTreeMap::new();
        let mut draws = Vec::new();
        let mut keys = Vec::new();
        for paint in paints {
            if paint.blur > 0.00001 {
                return Err(GlyphRasterError::Unsupported(
                    "per-character blur requires native filter composition",
                )
                .into());
            }
            // Canvas strokes a complete run before filling it; preserve this order for overlaps.
            for (kind, color) in [
                (
                    GlyphPaint::Stroke {
                        width: (paint.stroke_radius * 2.) as f32,
                    },
                    paint.stroke,
                ),
                (GlyphPaint::Fill, paint.fill),
            ] {
                if matches!(kind, GlyphPaint::Stroke { .. }) && paint.stroke_radius <= 0. {
                    continue;
                }
                let mut pen = [0.; 2];
                for glyph in &paint.shaped.glyphs {
                    let font = fonts
                        .iter()
                        .find(|f| f.matches_glyph(glyph))
                        .ok_or_else(|| {
                            ProjectRenderError::Invalid("glyph raster font absent".into())
                        })?;
                    let baseline = [
                        pen[0] + glyph.offset[0],
                        pen[1] + glyph.offset[1] + paint.shaped.middle_baseline_offset,
                    ];
                    let transform = surface_transform.compose(paint.transform);
                    // Canvas caches translated glyphs at quarter-pixel horizontal and integer vertical phases.
                    let translation = transform.0[0] == 1.
                        && transform.0[1] == 0.
                        && transform.0[2] == 0.
                        && transform.0[3] == 1.;
                    let baseline = if translation {
                        transform.point(baseline)
                    } else {
                        baseline
                    };
                    let baseline = if translation {
                        [(baseline[0] * 4.).round() / 4., baseline[1].round()]
                    } else {
                        baseline
                    };
                    let integer = baseline.map(f64::floor);
                    let phase = [
                        (baseline[0] - integer[0]) as f32,
                        (baseline[1] - integer[1]) as f32,
                    ]
                    .map(|n| n.min(f32::from_bits(0x3f7fffff)));
                    let request = GlyphRasterRequest {
                        glyph_id: glyph.glyph_id,
                        size: font_size as f32,
                        phase,
                        hinting: GlyphHinting::Platform,
                        coverage: aster_text::GlyphCoverage::CanvasSrgb,
                        paint: kind,
                        foreground: [
                            (color[0] * 255.).round() as u8,
                            (color[1] * 255.).round() as u8,
                            (color[2] * 255.).round() as u8,
                            255,
                        ],
                        prefer_bitmap: true,
                    };
                    let image = raster.rasterize(font, &request)?;
                    keys.push(image.key.clone());
                    draws.push(GlyphTextDraw {
                        placement: 0,
                        baseline: integer.map(|n| n as f32),
                        transform: if translation {
                            [1., 0., 0., 1., 0., 0.]
                        } else {
                            transform.0.map(|n| n as f32)
                        },
                        color: if image.format == GlyphImageFormat::PremultipliedSrgbRgba {
                            [1., 1., 1., color[3] as f32]
                        } else {
                            color.map(|n| n as f32)
                        },
                        clip: [0, 0, size.width, size.height],
                    });
                    images.insert(image.key.clone(), image);
                    if draws.len() > 16384 {
                        return Err(GlyphRasterError::Limit("project text glyph draws").into());
                    }
                    pen[0] += glyph.advance[0];
                    pen[1] += glyph.advance[1];
                }
            }
        }
        let atlas = generations.prepare(&images.into_values().collect::<Vec<_>>())?;
        let placements = atlas
            .placements
            .iter()
            .enumerate()
            .map(|(i, p)| (&p.key, i))
            .collect::<BTreeMap<_, _>>();
        for (draw, key) in draws.iter_mut().zip(&keys) {
            draw.placement = *placements.get(key).ok_or_else(|| {
                ProjectRenderError::Invalid("glyph atlas placement absent".into())
            })?;
        }
        Ok((atlas, GlyphTextPlan { size, draws }))
    }
}

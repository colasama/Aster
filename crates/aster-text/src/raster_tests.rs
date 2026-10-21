use std::sync::Arc;

use skrifa::bitmap::{BitmapData, BitmapGlyph, MaskData, Origin};

use crate::{
    GlyphGenerationConfig, GlyphGenerations, GlyphHinting, GlyphImageFormat, GlyphPaint,
    GlyphRasterConfig, GlyphRasterError, GlyphRasterRequest, GlyphRasterizer,
    raster_bitmap::BitmapRaster, shaping_tests::ShapingFixture,
};

impl GlyphRasterRequest {
    fn fixture() -> Self {
        Self {
            glyph_id: 2,
            size: 20.0,
            phase: [0.0; 2],
            hinting: GlyphHinting::None,
            paint: GlyphPaint::Fill,
            foreground: [255; 4],
            prefer_bitmap: true,
        }
    }
}

#[test]
fn outlines_preserve_fractional_origin_stroke_coverage_and_space_advance()
-> Result<(), Box<dyn std::error::Error>> {
    let font = ShapingFixture::font("Raster", &[(32, 1), (65, 2)])?;
    let mut raster = GlyphRasterizer::new(Default::default())?;
    let mut request = GlyphRasterRequest::fixture();
    let fill = raster.rasterize(&font, &request)?;
    assert_eq!([fill.width, fill.height], [10, 14]);
    assert_eq!(fill.origin, [0, -14]);
    assert!(fill.data.iter().all(|v| *v == 255));
    assert!(Arc::ptr_eq(&fill, &raster.rasterize(&font, &request)?));
    request.phase = [0.25, 0.25];
    let shifted = raster.rasterize(&font, &request)?;
    assert_eq!([shifted.width, shifted.height], [11, 15]);
    assert_ne!(shifted.key, fill.key);
    for y in 0..shifted.height {
        for x in 0..shifted.width {
            let overlap_x = ((x as f32 + 1.0).min(10.25) - (x as f32).max(0.25)).max(0.0);
            let overlap_y = ((y as f32 + 1.0).min(14.25) - (y as f32).max(0.25)).max(0.0);
            let expected = (overlap_x * overlap_y * 255.0).round() as i16;
            assert!(
                (i16::from(shifted.data[(y * shifted.width + x) as usize]) - expected).abs() <= 1
            );
        }
    }
    request.phase = [0.0; 2];
    request.paint = GlyphPaint::Stroke { width: 2.0 };
    let stroke = raster.rasterize(&font, &request)?;
    assert_eq!([stroke.width, stroke.height], [12, 16]);
    assert_eq!(
        stroke.data[(stroke.height / 2 * stroke.width + stroke.width / 2) as usize],
        0
    );
    request.paint = GlyphPaint::Fill;
    request.glyph_id = 1;
    let space = raster.rasterize(&font, &request)?;
    assert!(space.data.is_empty());
    assert_eq!([space.width, space.height], [0, 0]);
    assert_eq!(space.nominal_advance, 5.0);
    Ok(())
}

#[test]
fn raster_keys_and_limits_prevent_wrong_reuse_and_unbounded_work()
-> Result<(), Box<dyn std::error::Error>> {
    let font = ShapingFixture::font("Keys", &[(65, 2)])?;
    let base = GlyphRasterRequest::fixture();
    let key = base.key(&font)?;
    for change in 0..6 {
        let mut changed = base.clone();
        match change {
            0 => changed.size += 0.25,
            1 => changed.phase[1] = 0.25,
            2 => changed.hinting = GlyphHinting::Vertical,
            3 => changed.paint = GlyphPaint::Stroke { width: 1.0 },
            4 => changed.foreground[0] = 0,
            _ => changed.prefer_bitmap = false,
        }
        assert_ne!(key, changed.key(&font)?);
    }
    let mut invalid = base.clone();
    invalid.phase[0] = f32::NAN;
    assert!(invalid.key(&font).is_err());
    for config in [
        GlyphRasterConfig {
            max_glyph_dimension: 8,
            ..Default::default()
        },
        GlyphRasterConfig {
            max_outline_commands: 2,
            ..Default::default()
        },
    ] {
        assert!(matches!(
            GlyphRasterizer::new(config)?.rasterize(&font, &base),
            Err(GlyphRasterError::Limit(_))
        ));
    }
    let mut cache = GlyphRasterizer::new(GlyphRasterConfig {
        glyph_cache_entries: 1,
        ..Default::default()
    })?;
    let leased = cache.rasterize(&font, &base)?;
    let mut changed = base.clone();
    changed.phase[0] = 0.5;
    assert!(matches!(
        cache.rasterize(&font, &changed),
        Err(GlyphRasterError::Limit(_))
    ));
    drop(leased);
    assert!(cache.rasterize(&font, &changed).is_ok());
    Ok(())
}

#[test]
fn embedded_masks_and_png_colors_are_bounded_and_premultiplied()
-> Result<(), Box<dyn std::error::Error>> {
    let font = ShapingFixture::font("Bitmap", &[(65, 2)])?;
    let mut raster = GlyphRasterizer::new(Default::default())?;
    let request = GlyphRasterRequest::fixture();
    let mut output = (*raster.rasterize(&font, &request)?).clone();
    let mask = [255, 0, 128, 64];
    let mut bitmap = BitmapGlyph {
        data: BitmapData::Mask(MaskData {
            bpp: 8,
            is_packed: false,
            data: &mask,
        }),
        bearing_x: 0.0,
        bearing_y: 0.0,
        inner_bearing_x: 0.0,
        inner_bearing_y: 2.0,
        ppem_x: 20.0,
        ppem_y: 20.0,
        advance: None,
        width: 2,
        height: 2,
        placement_origin: Origin::TopLeft,
    };
    BitmapRaster::render(&bitmap, 1000, &request, &Default::default(), &mut output)?;
    assert_eq!(output.origin, [0, -2]);
    assert_eq!(output.data, mask);
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, 2, 2);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&[
            128, 64, 0, 128, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 255, 255,
        ])?;
    }
    bitmap.data = BitmapData::Png(&png);
    BitmapRaster::render(&bitmap, 1000, &request, &Default::default(), &mut output)?;
    assert_eq!(output.format, GlyphImageFormat::PremultipliedSrgbRgba);
    assert_eq!(&output.data[..4], &[64, 32, 0, 128]);
    output.validate(&Default::default())?;
    bitmap.width = 4097;
    assert!(matches!(
        BitmapRaster::render(&bitmap, 1000, &request, &Default::default(), &mut output),
        Err(GlyphRasterError::Limit(_))
    ));
    Ok(())
}

#[test]
fn immutable_atlas_generations_preserve_leased_coordinates_and_skip_empty_uploads()
-> Result<(), Box<dyn std::error::Error>> {
    let font = ShapingFixture::font("Atlas", &[(32, 1), (65, 2)])?;
    let mut raster = GlyphRasterizer::new(Default::default())?;
    let mut request = GlyphRasterRequest::fixture();
    let first = raster.rasterize(&font, &request)?;
    request.phase[0] = 0.25;
    let second = raster.rasterize(&font, &request)?;
    request.glyph_id = 1;
    let space = raster.rasterize(&font, &request)?;
    let mut atlas = GlyphGenerations::new(GlyphGenerationConfig {
        glyph_page_dimension: 256,
        max_glyph_generations: 1,
        ..Default::default()
    })?;
    let lease = atlas.prepare(&[Arc::clone(&first), Arc::clone(&space)])?;
    assert_eq!(lease.pages.len(), 1);
    assert!(lease.placements.iter().any(|p| p.page.is_none()));
    assert!(lease.pages[0].data[..256].iter().all(|v| *v == 0));
    assert!(Arc::ptr_eq(
        &lease,
        &atlas.prepare(&[Arc::clone(&space), Arc::clone(&first)])?
    ));
    let original = lease.pages[0].data.clone();
    assert!(matches!(
        atlas.prepare(&[Arc::clone(&second)]),
        Err(GlyphRasterError::Limit(_))
    ));
    assert_eq!(lease.pages[0].data, original);
    drop(lease);
    let changed = atlas.prepare(&[second])?;
    assert_eq!(changed.pages.len(), 1);
    drop(changed);
    let blank = atlas.prepare(&[space])?;
    assert!(blank.pages.is_empty());
    let mut corrupt = (*first).clone();
    corrupt.data[0] = 0;
    assert!(matches!(
        atlas.prepare(&[first, Arc::new(corrupt)]),
        Err(GlyphRasterError::Invalid(_))
    ));
    Ok(())
}

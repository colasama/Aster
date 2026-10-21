use crate::{
    FontCatalog, FontId, FontRequest, FontStyle, LoadedFont, NativeFont, TextAlignment,
    TextDirection, TextLayout, TextLayoutRequest, TextShapeConfig, TextShapeError, TextShaper,
    catalog_test_font::TestFont,
};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc};

struct ShapingFixture;
impl ShapingFixture {
    fn font(
        family: &str,
        mappings: &[(u32, u32)],
    ) -> Result<NativeFont, Box<dyn std::error::Error>> {
        let raw = TestFont::new(family, 400).bytes();
        let count = u16::from_be_bytes(raw[4..6].try_into()?) as usize;
        let mut tables = BTreeMap::new();
        for index in 0..count {
            let start = 12 + index * 16;
            let tag: [u8; 4] = raw[start..start + 4].try_into()?;
            let offset = u32::from_be_bytes(raw[start + 8..start + 12].try_into()?) as usize;
            let len = u32::from_be_bytes(raw[start + 12..start + 16].try_into()?) as usize;
            tables.insert(tag, raw[offset..offset + len].to_vec());
        }
        let mut hhea = vec![0; 36];
        hhea[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        hhea[4..6].copy_from_slice(&800_i16.to_be_bytes());
        hhea[6..8].copy_from_slice(&(-200_i16).to_be_bytes());
        hhea[34..36].copy_from_slice(&10_u16.to_be_bytes());
        tables.insert(*b"hhea", hhea);
        let mut hmtx = Vec::new();
        for advance in [600_u16, 250, 600, 700, 600, 600, 600, 0, 600, 600] {
            hmtx.extend(advance.to_be_bytes());
            hmtx.extend(0_i16.to_be_bytes());
        }
        tables.insert(*b"hmtx", hmtx);
        let os2 = tables.get_mut(b"OS/2").ok_or("OS/2 missing")?;
        os2[68..70].copy_from_slice(&800_i16.to_be_bytes());
        os2[70..72].copy_from_slice(&(-200_i16).to_be_bytes());
        let mut cmap = Vec::new();
        for value in [0_u16, 1, 3, 10] {
            cmap.extend(value.to_be_bytes());
        }
        cmap.extend(12_u32.to_be_bytes());
        cmap.extend(12_u16.to_be_bytes());
        cmap.extend(0_u16.to_be_bytes());
        cmap.extend((16 + 12 * mappings.len() as u32).to_be_bytes());
        cmap.extend(0_u32.to_be_bytes());
        cmap.extend((mappings.len() as u32).to_be_bytes());
        for (cp, glyph) in mappings {
            cmap.extend(cp.to_be_bytes());
            cmap.extend(cp.to_be_bytes());
            cmap.extend(glyph.to_be_bytes());
        }
        tables.insert(*b"cmap", cmap);
        let mut bytes = vec![0; 12 + 16 * tables.len()];
        bytes[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        bytes[4..6].copy_from_slice(&(tables.len() as u16).to_be_bytes());
        for (index, (tag, table)) in tables.into_iter().enumerate() {
            while !bytes.len().is_multiple_of(4) {
                bytes.push(0);
            }
            let start = 12 + 16 * index;
            let offset = bytes.len() as u32;
            bytes[start..start + 4].copy_from_slice(&tag);
            bytes[start + 8..start + 12].copy_from_slice(&offset.to_be_bytes());
            bytes[start + 12..start + 16].copy_from_slice(&(table.len() as u32).to_be_bytes());
            bytes.extend(table);
        }
        let sha256 = Sha256::digest(&bytes).into();
        let loaded = LoadedFont {
            id: FontId(1),
            sha256,
            data: Arc::from(bytes),
        };
        let mut catalog = FontCatalog::new(Default::default())?;
        catalog.insert(loaded.clone())?;
        let selection = catalog
            .select(&FontRequest {
                families: vec![family.to_owned()],
                weight: 400.0,
                width_percent: 100.0,
                style: FontStyle::Normal,
            })?
            .ok_or("selection missing")?;
        Ok(NativeFont::new(selection, loaded)?)
    }
    fn request(text: &str) -> TextLayoutRequest {
        TextLayoutRequest {
            text: text.to_owned(),
            width: 40.0,
            height: 60.0,
            font_size: 20.0,
            tracking: 0.0,
            leading: 24.0,
            alignment: TextAlignment::Center,
            direction: TextDirection::LeftToRight,
            language: "en-US".to_owned(),
            per_grapheme: false,
        }
    }
}

#[test]
fn native_shaping_preserves_utf16_spans_metrics_and_fallback_faces()
-> Result<(), Box<dyn std::error::Error>> {
    let first = ShapingFixture::font("First", &[(32, 1), (65, 2), (0x1f600, 6)])?;
    let second = ShapingFixture::font("Second", &[(66, 3)])?;
    let shaper = TextShaper::new(Default::default())?;
    let shaped = shaper.shape(
        "A\u{1f600}B",
        20.0,
        TextDirection::LeftToRight,
        "en-US",
        &[first.clone(), second.clone()],
    )?;
    assert_eq!(shaped.advance, 38.0);
    assert_eq!(shaped.middle_baseline_offset, 6.0);
    assert_eq!(
        shaped
            .glyphs
            .iter()
            .map(|g| (g.cluster_start, g.cluster_end))
            .collect::<Vec<_>>(),
        [(0, 1), (1, 3), (3, 4)]
    );
    assert_eq!(shaped.glyphs[0].face, first.selection.face);
    assert_eq!(shaped.glyphs[2].face, second.selection.face);
    serde_json::to_string(&shaped)?;
    Ok(())
}

#[test]
fn native_layout_preserves_wrapping_baseline_tracking_and_first_token_overflow()
-> Result<(), Box<dyn std::error::Error>> {
    let fonts = [ShapingFixture::font(
        "Layout",
        &[(32, 1), (65, 2), (66, 3)],
    )?];
    let layout = TextLayout::new(Default::default())?;
    let result = layout.evaluate(&ShapingFixture::request("AB AB"), &fonts)?;
    assert_eq!(
        result
            .lines
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>(),
        ["AB", "AB"]
    );
    assert!((result.lines[0].origin[0] - 7.0).abs() < 1e-12);
    assert_eq!(result.lines[0].origin[1], 18.0);
    assert!((result.lines[1].origin[0] - 7.0).abs() < 1e-12);
    assert_eq!(result.lines[1].origin[1], 42.0);
    let overflow = layout.evaluate(&ShapingFixture::request("AAAAAA"), &fonts)?;
    assert_eq!(overflow.lines.len(), 1);
    assert_eq!(overflow.lines[0].width, 72.0);
    let mut request = ShapingFixture::request("AB");
    request.tracking = 3.0;
    let tracked = layout.evaluate(&request, &fonts)?;
    assert_eq!(tracked.lines[0].width, 29.0);
    assert_eq!(tracked.lines[0].fragments[1].x, 15.0);
    let empty = layout.evaluate(&ShapingFixture::request("\r\n\n"), &fonts)?;
    assert_eq!(empty.lines.len(), 3);
    assert!(empty.lines.iter().all(|l| l.text.is_empty()));
    Ok(())
}

#[test]
fn native_text_rejects_missing_glyphs_nonfinite_inputs_and_resource_exhaustion()
-> Result<(), Box<dyn std::error::Error>> {
    let fonts = [ShapingFixture::font(
        "Bounded",
        &[(32, 1), (65, 2), (66, 3)],
    )?];
    let shaper = TextShaper::new(TextShapeConfig {
        max_text_codepoints: 2,
        ..Default::default()
    })?;
    assert!(matches!(
        shaper.shape("AAA", 20.0, TextDirection::LeftToRight, "en", &fonts),
        Err(TextShapeError::Limit(_))
    ));
    assert!(matches!(
        shaper.shape("C", 20.0, TextDirection::LeftToRight, "en", &fonts),
        Err(TextShapeError::MissingGlyph { start: 0, end: 1 })
    ));
    assert!(
        shaper
            .shape("A", f64::NAN, TextDirection::LeftToRight, "en", &fonts)
            .is_err()
    );
    let layout = TextLayout::new(TextShapeConfig {
        max_layout_work: 3,
        ..Default::default()
    })?;
    assert!(matches!(
        layout.evaluate(&ShapingFixture::request("AB AB"), &fonts),
        Err(TextShapeError::Limit(_))
    ));
    assert!(
        TextShaper::new(TextShapeConfig {
            max_text_codepoints: usize::MAX,
            ..Default::default()
        })
        .is_err()
    );
    Ok(())
}

#[test]
fn native_shaping_preserves_homogeneous_rtl_runs_without_accepting_mixed_bidi()
-> Result<(), Box<dyn std::error::Error>> {
    let fonts = [ShapingFixture::font(
        "Direction",
        &[(65, 2), (0x627, 2), (0x628, 3)],
    )?];
    let shaper = TextShaper::new(Default::default())?;
    let shaped = shaper.shape(
        "\u{627}\u{628}",
        20.0,
        TextDirection::LeftToRight,
        "ar",
        &fonts,
    )?;
    assert_eq!(
        shaped
            .glyphs
            .iter()
            .map(|g| g.cluster_start)
            .collect::<Vec<_>>(),
        [1, 0]
    );
    assert!(matches!(
        shaper.shape(
            "A\u{627}\u{628}",
            20.0,
            TextDirection::LeftToRight,
            "ar",
            &fonts
        ),
        Err(TextShapeError::Unsupported(_))
    ));
    Ok(())
}

use super::catalog_test_font::TestFont;
use crate::{FontAxis, FontCatalog, FontCatalogConfig, FontRequest, FontStyle};

#[test]
fn collection_faces_and_bytes_are_admitted_atomically() -> Result<(), Box<dyn std::error::Error>> {
    let mut catalog = FontCatalog::new(FontCatalogConfig::default())?;
    let valid = TestFont::loaded(TestFont::collection(&[
        TestFont::new("Aster Test", 400),
        TestFont::new("Aster Test", 700),
    ]));
    let ids = catalog.insert(valid.clone())?;
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    assert_eq!(catalog.statistics(), (1, 2, valid.data.len() as u64));
    assert_eq!(catalog.insert(valid.clone())?, ids);
    let invalid = TestFont::loaded(TestFont::collection(&[
        TestFont::new("Different", 400),
        TestFont::new("Broken", 0),
    ]));
    assert!(catalog.insert(invalid).is_err());
    assert_eq!(catalog.statistics(), (1, 2, valid.data.len() as u64));
    let retained = catalog.face(ids[0]).ok_or("missing admitted face")?.1;
    assert!(catalog.remove(valid.sha256));
    assert_eq!(catalog.statistics(), (0, 0, 0));
    assert_eq!(retained.data, valid.data);
    assert!(!catalog.remove(valid.sha256));
    Ok(())
}

#[test]
fn all_catalog_limits_reject_without_partial_admission() -> Result<(), Box<dyn std::error::Error>> {
    let data = TestFont::collection(&[TestFont::new("First", 400), TestFont::new("Second", 400)]);
    for config in [
        FontCatalogConfig {
            max_catalog_faces: 1,
            ..Default::default()
        },
        FontCatalogConfig {
            max_catalog_bytes: (data.len() - 1) as u64,
            ..Default::default()
        },
        FontCatalogConfig {
            max_catalog_family_names: 1,
            ..Default::default()
        },
        FontCatalogConfig {
            max_name_chars: 2,
            ..Default::default()
        },
    ] {
        let mut catalog = FontCatalog::new(config)?;
        assert!(catalog.insert(TestFont::loaded(data.clone())).is_err());
        assert_eq!(catalog.statistics(), (0, 0, 0));
    }
    let mut catalog = FontCatalog::new(FontCatalogConfig::default())?;
    let mut corrupt_hash = TestFont::loaded(TestFont::new("Hash", 400).bytes());
    corrupt_hash.sha256[0] ^= 1;
    assert!(catalog.insert(corrupt_hash).is_err());
    for data in [b"wOF2 unsupported".to_vec(), vec![0; 40], Vec::new()] {
        assert!(catalog.insert(TestFont::loaded(data)).is_err());
    }
    assert_eq!(catalog.statistics(), (0, 0, 0));
    Ok(())
}

#[test]
fn family_order_and_unicode_caseless_matching_do_not_normalize()
-> Result<(), Box<dyn std::error::Error>> {
    let mut catalog = FontCatalog::new(FontCatalogConfig::default())?;
    let first = catalog.insert(TestFont::loaded(TestFont::new("Straße", 400).bytes()))?[0];
    let second = catalog.insert(TestFont::loaded(TestFont::new("Åster", 400).bytes()))?[0];
    let mut request = FontRequest {
        families: vec!["Missing".into(), "STRASSE".into(), "Åster".into()],
        weight: 400.0,
        width_percent: 100.0,
        style: FontStyle::Normal,
    };
    assert_eq!(
        catalog.select(&request)?.ok_or("no family match")?.face,
        first
    );
    request.families = vec!["åster".into()];
    assert_eq!(
        catalog.select(&request)?.ok_or("no Unicode match")?.face,
        second
    );
    request.families = vec!["A\u{30a}ster".into()];
    assert_eq!(catalog.select(&request)?, None);
    request.families = vec!["Straße\0".into()];
    assert!(catalog.select(&request).is_err());
    request.weight = f32::NAN;
    assert!(catalog.select(&request).is_err());
    Ok(())
}

#[test]
fn weight_matching_obeys_direction_and_special_middle_range()
-> Result<(), Box<dyn std::error::Error>> {
    let mut catalog = FontCatalog::new(FontCatalogConfig::default())?;
    for weight in [300, 500, 700, 900] {
        catalog.insert(TestFont::loaded(TestFont::new("Weights", weight).bytes()))?;
    }
    for (requested, expected) in [
        (400.0, 500.0),
        (450.0, 500.0),
        (550.0, 700.0),
        (250.0, 300.0),
        (750.0, 900.0),
    ] {
        let request = FontRequest {
            families: vec!["Weights".into()],
            weight: requested,
            width_percent: 100.0,
            style: FontStyle::Normal,
        };
        assert_eq!(
            catalog.select(&request)?.ok_or("no weight match")?.weight,
            expected
        );
    }
    Ok(())
}

#[test]
fn width_then_style_then_weight_and_content_identity_break_ties()
-> Result<(), Box<dyn std::error::Error>> {
    let mut narrow = TestFont::new("Priority", 300);
    narrow.width = 4;
    narrow.style = FontStyle::Italic;
    let mut wide = TestFont::new("Priority", 700);
    wide.width = 6;
    let normal = TestFont::new("Priority", 300);
    let mut italic = TestFont::new("Priority", 500);
    italic.style = FontStyle::Italic;
    let fonts = [narrow, wide, normal, italic, TestFont::new("priority", 300)]
        .map(|f| TestFont::loaded(f.bytes()));
    let mut left = FontCatalog::new(FontCatalogConfig::default())?;
    let mut right = FontCatalog::new(FontCatalogConfig::default())?;
    for font in &fonts {
        left.insert(font.clone())?;
    }
    for font in fonts.iter().rev() {
        right.insert(font.clone())?;
    }
    let request = FontRequest {
        families: vec!["Priority".into()],
        weight: 700.0,
        width_percent: 100.0,
        style: FontStyle::Normal,
    };
    let selection = left.select(&request)?.ok_or("no ranked face")?;
    assert_eq!(selection.weight, 300.0);
    assert_eq!(selection.width_percent, 100.0);
    assert_eq!(left.select(&request)?, right.select(&request)?);
    let mut widths = FontCatalog::new(FontCatalogConfig::default())?;
    for font in &fonts[..2] {
        widths.insert(font.clone())?;
    }
    assert_eq!(
        widths
            .select(&request)?
            .ok_or("no width match")?
            .width_percent,
        87.5
    );
    Ok(())
}

#[test]
fn variation_ranges_are_preserved_and_clamped_before_selection()
-> Result<(), Box<dyn std::error::Error>> {
    let mut font = TestFont::new("Variable", 400);
    font.axes = vec![
        FontAxis {
            tag: *b"wght",
            minimum: 200.0,
            default: 400.0,
            maximum: 800.0,
        },
        FontAxis {
            tag: *b"wdth",
            minimum: 80.0,
            default: 100.0,
            maximum: 120.0,
        },
        FontAxis {
            tag: *b"opsz",
            minimum: 8.0,
            default: 14.0,
            maximum: 72.0,
        },
    ];
    let mut catalog = FontCatalog::new(FontCatalogConfig::default())?;
    let id = catalog.insert(TestFont::loaded(font.bytes()))?[0];
    let request = FontRequest {
        families: vec!["Variable".into()],
        weight: 575.5,
        width_percent: 140.0,
        style: FontStyle::Normal,
    };
    let selection = catalog.select(&request)?.ok_or("no variable face")?;
    assert_eq!(selection.face, id);
    assert_eq!(selection.weight, 575.5);
    assert_eq!(selection.width_percent, 120.0);
    assert_eq!(selection.variations.get(b"opsz"), Some(&14.0));
    font.axes[0].minimum = 450.0;
    assert!(catalog.insert(TestFont::loaded(font.bytes())).is_err());
    assert_eq!(catalog.statistics().1, 1);
    Ok(())
}

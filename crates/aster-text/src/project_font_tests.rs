use std::collections::BTreeMap;
use std::io::Write;

use aster_types::editor::{Field, ProjectFont};
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, write::ZlibEncoder};

use crate::{
    FontAxis, FontCatalog, FontCatalogConfig, FontRequest, FontStyle, ProjectFontConfig,
    ProjectFontFallback, ProjectFontResolution, ProjectFontSet, catalog_test_font::TestFont,
    woff::WoffDecoder,
};

impl TestFont {
    fn embedded(&self, id: &str, alias: &str, weight: u16) -> ProjectFont {
        ProjectFont {
            id: id.into(),
            name: "Test.ttf".into(),
            family: alias.into(),
            weight: weight.into(),
            weight_range: Field::Absent,
            data_url: format!("data:font/ttf;base64,{}", STANDARD.encode(self.bytes())),
            extensions: BTreeMap::new(),
        }
    }

    fn woff(&self) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let sfnt = self.bytes();
        let count = usize::from(u16::from_be_bytes([sfnt[4], sfnt[5]]));
        let mut output = vec![0; 44 + count * 20];
        output[..4].copy_from_slice(b"wOFF");
        output[4..8].copy_from_slice(&sfnt[..4]);
        output[12..14].copy_from_slice(&(count as u16).to_be_bytes());
        let mut total = 12 + count * 16;
        for index in 0..count {
            let directory = 12 + index * 16;
            let offset =
                u32::from_be_bytes(sfnt[directory + 8..directory + 12].try_into()?) as usize;
            let length =
                u32::from_be_bytes(sfnt[directory + 12..directory + 16].try_into()?) as usize;
            let table = &sfnt[offset..offset + length];
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(table)?;
            let encoded = encoder.finish()?;
            let stored = if encoded.len() < table.len() {
                &encoded
            } else {
                table
            };
            while !output.len().is_multiple_of(4) {
                output.push(0);
            }
            let position = output.len() as u32;
            let entry = 44 + index * 20;
            output[entry..entry + 4].copy_from_slice(&sfnt[directory..directory + 4]);
            output[entry + 4..entry + 8].copy_from_slice(&position.to_be_bytes());
            output[entry + 8..entry + 12].copy_from_slice(&(stored.len() as u32).to_be_bytes());
            output[entry + 12..entry + 16].copy_from_slice(&(table.len() as u32).to_be_bytes());
            output[entry + 16..entry + 20]
                .copy_from_slice(&WoffDecoder::checksum(table).to_be_bytes());
            output.extend(stored);
            total += (table.len() + 3) & !3;
        }
        while !output.len().is_multiple_of(4) {
            output.push(0);
        }
        let length = output.len() as u32;
        output[8..12].copy_from_slice(&length.to_be_bytes());
        output[16..20].copy_from_slice(&(total as u32).to_be_bytes());
        Ok(output)
    }
}

#[test]
fn project_alias_wins_and_retained_bytes_survive_atomic_replacement()
-> Result<(), Box<dyn std::error::Error>> {
    let mut platform = FontCatalog::new(FontCatalogConfig::default())?;
    platform.insert(TestFont::loaded(TestFont::new("Alias", 400).bytes()))?;
    let request = FontRequest {
        families: vec!["Alias".into()],
        weight: 400.0,
        width_percent: 100.0,
        style: FontStyle::Normal,
    };
    let mut set = ProjectFontSet::new(ProjectFontConfig::default())?;
    let font = TestFont::new("Internal Family", 700).embedded("one", "Alias", 400);
    assert!(set.replace(std::slice::from_ref(&font))?);
    let ProjectFontResolution::Native {
        selection, font_id, ..
    } = set.resolve(&request, &platform)?
    else {
        return Err("project font did not win".into());
    };
    assert_eq!(font_id, "one");
    assert_eq!(selection.family, "Alias");
    let held = set.face(selection.face).ok_or("font disappeared")?.1;
    let revision = set.revision();
    assert!(!set.replace(std::slice::from_ref(&font))?);
    let mut invalid = font.clone();
    invalid.id = "invalid".into();
    invalid.data_url = "data:font/ttf;base64,AAAA".into();
    invalid.family = "Invalid".into();
    assert!(set.replace(&[font.clone(), invalid]).is_err());
    assert_eq!(set.revision(), revision);
    assert!(set.replace(&[])?);
    assert_ne!(set.revision(), revision);
    assert!(!held.data.is_empty());
    assert!(matches!(
        set.resolve(&request, &platform)?,
        ProjectFontResolution::Platform(_)
    ));
    Ok(())
}

#[test]
fn variable_descriptors_select_and_constrain_physical_axes()
-> Result<(), Box<dyn std::error::Error>> {
    let mut variable = TestFont::new("Physical", 400);
    variable.axes.push(FontAxis {
        tag: *b"wght",
        minimum: 100.0,
        default: 400.0,
        maximum: 900.0,
    });
    let mut light = variable.embedded("light", "Alias", 400);
    light.weight_range = Field::Value([100.into(), 500.into()]);
    let heavy = TestFont::new("Heavy", 900).embedded("heavy", "Alias", 700);
    let mut set = ProjectFontSet::new(ProjectFontConfig::default())?;
    set.replace(&[light.clone(), heavy])?;
    let platform = FontCatalog::new(FontCatalogConfig::default())?;
    for (weight, expected_id, expected_axis) in [
        (450.0, "light", Some(450.0)),
        (550.0, "heavy", None),
        (50.0, "light", Some(100.0)),
    ] {
        let request = FontRequest {
            families: vec!["Alias".into()],
            weight,
            width_percent: 100.0,
            style: FontStyle::Normal,
        };
        let ProjectFontResolution::Native {
            selection, font_id, ..
        } = set.resolve(&request, &platform)?
        else {
            return Err("missing native alias".into());
        };
        assert_eq!(font_id, expected_id);
        assert_eq!(selection.variations.get(b"wght").copied(), expected_axis);
    }
    set.replace(std::slice::from_ref(&light))?;
    let revision = set.revision();
    light.weight = 450.into();
    assert!(set.replace(&[light])?);
    assert_ne!(set.revision(), revision);
    Ok(())
}

#[test]
fn unsupported_project_font_blocks_silent_system_substitution()
-> Result<(), Box<dyn std::error::Error>> {
    let mut platform = FontCatalog::new(FontCatalogConfig::default())?;
    platform.insert(TestFont::loaded(TestFont::new("Alias", 400).bytes()))?;
    let mut font = TestFont::new("Physical", 400).embedded("compressed", "Alias", 400);
    font.data_url = format!(
        "data:font/woff2;base64,{}",
        STANDARD.encode(b"wOF2 opaque decoder input")
    );
    let mut set = ProjectFontSet::new(ProjectFontConfig::default())?;
    set.replace(&[font])?;
    let request = FontRequest {
        families: vec!["Missing".into(), "Alias".into()],
        weight: 400.0,
        width_percent: 100.0,
        style: FontStyle::Normal,
    };
    assert!(matches!(
        set.resolve(&request, &platform)?,
        ProjectFontResolution::RetainedRaster {
            reason: ProjectFontFallback::Woff2DecoderUnavailable,
            ..
        }
    ));
    Ok(())
}

#[test]
fn embedded_schema_and_aggregate_budgets_are_checked_before_publication()
-> Result<(), Box<dyn std::error::Error>> {
    let font = TestFont::new("Physical", 400).embedded("one", "Alias", 400);
    let mut set = ProjectFontSet::new(ProjectFontConfig::default())?;
    set.replace(std::slice::from_ref(&font))?;
    let revision = set.revision();
    let mut overlapping = font.clone();
    overlapping.id = "two".into();
    overlapping.weight_range = Field::Value([100.into(), 900.into()]);
    assert!(set.replace(&[font.clone(), overlapping]).is_err());
    for invalid in [
        "data:font/ttf;base64,A===",
        "data:font/ttf;base64,AA A",
        "data:font/ttf;base64,AAA",
        "data:font/nope;base64,AAAA",
    ] {
        let mut item = font.clone();
        item.data_url = invalid.into();
        assert!(set.replace(&[item]).is_err());
    }
    let mut invalid = font.clone();
    invalid.family = "😀".repeat(81);
    assert!(set.replace(&[invalid]).is_err());
    assert_eq!(set.revision(), revision);
    let mut bounded = ProjectFontSet::new(ProjectFontConfig {
        max_project_font_bytes: 64,
        ..Default::default()
    })?;
    assert!(bounded.replace(std::slice::from_ref(&font)).is_err());
    let mut bounded = ProjectFontSet::new(ProjectFontConfig {
        max_decoded_project_font_bytes: 64,
        ..Default::default()
    })?;
    assert!(bounded.replace(&[font]).is_err());
    Ok(())
}

#[test]
fn bounded_woff_reconstruction_checks_checksums_lengths_and_overlaps()
-> Result<(), Box<dyn std::error::Error>> {
    let font = TestFont::new("Woff Family", 400);
    let bytes = font.woff()?;
    let decoded = WoffDecoder::decode(&bytes, 4096, 512)?;
    assert_eq!(WoffDecoder::checksum(&decoded), 0xb1b0_afba);
    let mut catalog = FontCatalog::new(FontCatalogConfig::default())?;
    catalog.insert(TestFont::loaded(decoded.clone()))?;
    assert!(WoffDecoder::decode(&bytes, decoded.len() - 1, 512).is_err());
    assert!(WoffDecoder::decode(&bytes, 4096, 1).is_err());
    let mut trailing = bytes.clone();
    trailing.extend([0; 4]);
    let length = trailing.len() as u32;
    trailing[8..12].copy_from_slice(&length.to_be_bytes());
    assert!(WoffDecoder::decode(&trailing, 4096, 512).is_err());
    // The first compressed table expands beyond this claimed size without changing padding.
    let mut short_output = bytes.clone();
    let original = u32::from_be_bytes(short_output[56..60].try_into()?);
    short_output[56..60].copy_from_slice(&(original - 1).to_be_bytes());
    assert!(WoffDecoder::decode(&short_output, 4096, 512).is_err());
    for position in [14, 16, 48, 52, 56, 60] {
        let mut corrupted = bytes.clone();
        corrupted[position] ^= 0x80;
        assert!(
            WoffDecoder::decode(&corrupted, 4096, 512).is_err(),
            "accepted corruption at {position}"
        );
    }
    let mut embedded = font.embedded("woff", "Alias", 400);
    embedded.data_url = format!("data:font/woff;base64,{}", STANDARD.encode(&bytes));
    let mut set = ProjectFontSet::new(ProjectFontConfig::default())?;
    assert!(set.replace(&[embedded])?);
    Ok(())
}

use std::collections::BTreeMap;

use icu_casemap::CaseMapper;
use read_fonts::{FontRef, TableProvider, tables::os2::SelectionFlags, types::NameId};

use crate::catalog::{FontCatalogConfig, FontCatalogError};

#[derive(
    Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, serde::Serialize, serde::Deserialize,
)]
pub struct FontFaceId {
    pub sha256: [u8; 32],
    pub index: u32,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FontStyle {
    #[default]
    Normal,
    Italic,
    Oblique,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FontAxis {
    pub tag: [u8; 4],
    pub minimum: f32,
    pub default: f32,
    pub maximum: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FontFaceMetadata {
    pub id: FontFaceId,
    pub families: BTreeMap<String, String>,
    pub weight: f32,
    pub width_percent: f32,
    pub style: FontStyle,
    pub units_per_em: u16,
    pub glyph_count: u16,
    pub axes: BTreeMap<[u8; 4], FontAxis>,
}

impl FontFaceMetadata {
    pub(crate) fn read(
        font: FontRef<'_>,
        id: FontFaceId,
        limits: &FontCatalogConfig,
    ) -> Result<Self, FontCatalogError> {
        let names = font.name()?;
        if names.name_record().len() > limits.max_name_records {
            return Err(FontCatalogError::Limit("font name records"));
        }
        let mut families = BTreeMap::new();
        for record in names.name_record() {
            if ![NameId::FAMILY_NAME, NameId::TYPOGRAPHIC_FAMILY_NAME].contains(&record.name_id())
                || !(record.is_unicode()
                    || (record.platform_id() == 1 && record.encoding_id() == 0))
            {
                continue;
            }
            if record.is_unicode() && !record.length().is_multiple_of(2) {
                return Err(FontCatalogError::Invalid(
                    "font family name has truncated UTF-16",
                ));
            }
            let name: String = record
                .string(names.string_data())?
                .chars()
                .take(limits.max_name_chars.saturating_add(1))
                .collect();
            let key = Self::family_key(&name, limits.max_name_chars)?;
            families.entry(key).or_insert(name);
        }
        if families.is_empty() {
            return Err(FontCatalogError::Invalid(
                "font has no supported family name",
            ));
        }
        let head = font.head()?;
        let units_per_em = head.units_per_em();
        let glyph_count = font.maxp()?.num_glyphs();
        if !(16..=16_384).contains(&units_per_em) || glyph_count == 0 {
            return Err(FontCatalogError::Invalid("font metrics are invalid"));
        }
        let os2 = font.os2()?;
        let weight = f32::from(os2.us_weight_class());
        if !(1.0..=1000.0).contains(&weight) {
            return Err(FontCatalogError::Invalid("font weight is invalid"));
        }
        let width_percent = match os2.us_width_class() {
            1 => 50.0,
            2 => 62.5,
            3 => 75.0,
            4 => 87.5,
            5 => 100.0,
            6 => 112.5,
            7 => 125.0,
            8 => 150.0,
            9 => 200.0,
            _ => return Err(FontCatalogError::Invalid("font width is invalid")),
        };
        let flags = os2.fs_selection();
        let style = if flags.contains(SelectionFlags::OBLIQUE) {
            FontStyle::Oblique
        } else if flags.contains(SelectionFlags::ITALIC) {
            FontStyle::Italic
        } else {
            FontStyle::Normal
        };
        let mut axes = BTreeMap::new();
        match font.fvar() {
            Ok(fvar) => {
                let records = fvar.axes()?;
                if records.len() > limits.max_axes {
                    return Err(FontCatalogError::Limit("font variation axes"));
                }
                for record in records {
                    let tag = record.axis_tag().to_be_bytes();
                    let axis = FontAxis {
                        tag,
                        minimum: record.min_value().to_f32(),
                        default: record.default_value().to_f32(),
                        maximum: record.max_value().to_f32(),
                    };
                    if axis.minimum > axis.default
                        || axis.default > axis.maximum
                        || (tag == *b"wght" && (axis.minimum < 1.0 || axis.maximum > 1000.0))
                        || (tag == *b"wdth" && axis.minimum <= 0.0)
                        || axes.insert(tag, axis).is_some()
                    {
                        return Err(FontCatalogError::Invalid("font variation range is invalid"));
                    }
                }
            }
            Err(read_fonts::ReadError::TableIsMissing(_)) => {}
            Err(error) => return Err(error.into()),
        }
        Ok(Self {
            id,
            families,
            weight,
            width_percent,
            style,
            units_per_em,
            glyph_count,
            axes,
        })
    }

    /// Match Unicode family names without normalization or locale-specific tailoring.
    pub(crate) fn family_key(name: &str, max_chars: usize) -> Result<String, FontCatalogError> {
        if name.is_empty() || name.chars().count() > max_chars {
            return Err(FontCatalogError::Limit("font family name"));
        }
        if name.chars().any(char::is_control) {
            return Err(FontCatalogError::Invalid(
                "font family name contains control characters",
            ));
        }
        Ok(CaseMapper::new().fold_string(name).into_owned())
    }
}

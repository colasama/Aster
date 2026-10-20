use std::collections::BTreeMap;

use aster_types::editor::{Field, ProjectFont};
use base64::{
    Engine, alphabet,
    engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
};

use crate::FontCatalogError;

#[derive(Clone, Debug, clap::Args)]
pub struct ProjectFontConfig {
    #[arg(long, default_value_t = Self::default().max_project_fonts)]
    pub max_project_fonts: usize,
    #[arg(long, default_value_t = Self::default().max_project_font_bytes)]
    pub max_project_font_bytes: usize,
    #[arg(long, default_value_t = Self::default().max_decoded_project_font_bytes)]
    pub max_decoded_project_font_bytes: usize,
    #[arg(long, default_value_t = Self::default().max_project_font_tables)]
    pub max_project_font_tables: usize,
}

impl Default for ProjectFontConfig {
    fn default() -> Self {
        Self {
            max_project_fonts: 32,
            max_project_font_bytes: 8 * 1024 * 1024,
            max_decoded_project_font_bytes: 64 * 1024 * 1024,
            max_project_font_tables: 512,
        }
    }
}

pub(crate) struct ProjectFontInput {
    pub id: String,
    pub family: String,
    pub weight: f32,
    pub range: [f32; 2],
    pub bytes: Vec<u8>,
}

impl ProjectFontInput {
    pub fn validate(
        fonts: &[ProjectFont],
        config: &ProjectFontConfig,
    ) -> Result<Vec<Self>, FontCatalogError> {
        // Runtime budgets can be lowered; the persisted schema's limits cannot be widened.
        if config.max_project_fonts == 0
            || config.max_project_font_bytes == 0
            || config.max_decoded_project_font_bytes == 0
            || config.max_project_font_tables == 0
            || fonts.len() > config.max_project_fonts.min(32)
        {
            return Err(FontCatalogError::Limit("project fonts"));
        }
        let source_budget = config.max_project_font_bytes.min(8 * 1024 * 1024);
        let mut total = 0_usize;
        let mut ids = BTreeMap::new();
        let mut ranges: BTreeMap<String, Vec<[f32; 2]>> = BTreeMap::new();
        let mut validated = Vec::with_capacity(fonts.len());
        let decoder = GeneralPurpose::new(
            &alphabet::STANDARD,
            GeneralPurposeConfig::new()
                .with_decode_allow_trailing_bits(true)
                .with_decode_padding_mode(DecodePaddingMode::RequireCanonical),
        );
        for font in fonts {
            for value in [&font.id, &font.name, &font.family] {
                if value.encode_utf16().count() > 160
                    || value
                        .trim_matches(|c: char| {
                            (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
                        })
                        .is_empty()
                {
                    return Err(FontCatalogError::Invalid("invalid project font descriptor"));
                }
            }
            let weight = font
                .weight
                .as_f64()
                .filter(|v| v.fract() == 0.0 && (100.0..=900.0).contains(v))
                .ok_or(FontCatalogError::Invalid("invalid project font weight"))?
                as f32;
            let range = match &font.weight_range {
                Field::Absent => [weight, weight],
                Field::Value(values) => {
                    let mut range = [0.0; 2];
                    for (index, number) in values.iter().enumerate() {
                        range[index] = number
                            .as_f64()
                            .filter(|v| v.fract() == 0.0 && (100.0..=900.0).contains(v))
                            .ok_or(FontCatalogError::Invalid("invalid project font range"))?
                            as f32;
                    }
                    if range[0] > weight || range[1] < weight {
                        return Err(FontCatalogError::Invalid(
                            "project font range excludes default",
                        ));
                    }
                    range
                }
                Field::Null => return Err(FontCatalogError::Invalid("null project font range")),
            };
            let siblings = ranges.entry(font.family.to_lowercase()).or_default();
            if ids.insert(font.id.clone(), ()).is_some()
                || siblings
                    .iter()
                    .any(|prior| range[0] <= prior[1] && range[1] >= prior[0])
            {
                return Err(FontCatalogError::Invalid(
                    "duplicate project font or overlapping range",
                ));
            }
            siblings.push(range);
            if font.data_url.len() > source_budget.div_ceil(3) * 4 + 64 {
                return Err(FontCatalogError::Limit("project font data URL"));
            }
            let (prefix, encoded) = font
                .data_url
                .split_once(',')
                .ok_or(FontCatalogError::Invalid("invalid project font data URL"))?;
            if ![
                "data:font/ttf;base64",
                "data:font/otf;base64",
                "data:font/woff;base64",
                "data:font/woff2;base64",
            ]
            .contains(&prefix)
                || encoded.is_empty()
                || !encoded.len().is_multiple_of(4)
            {
                return Err(FontCatalogError::Invalid("invalid project font data URL"));
            }
            let padding = encoded
                .as_bytes()
                .iter()
                .rev()
                .take_while(|b| **b == b'=')
                .count();
            if padding > 2
                || encoded[..encoded.len() - padding]
                    .bytes()
                    .any(|b| !(b.is_ascii_alphanumeric() || b == b'+' || b == b'/'))
            {
                return Err(FontCatalogError::Invalid("invalid project font base64"));
            }
            total = total
                .checked_add(encoded.len() / 4 * 3 - padding)
                .filter(|v| *v <= source_budget)
                .ok_or(FontCatalogError::Limit("project font source bytes"))?;
            let bytes = decoder
                .decode(encoded)
                .map_err(|_| FontCatalogError::Invalid("invalid project font base64"))?;
            validated.push(Self {
                id: font.id.clone(),
                family: font.family.clone(),
                weight,
                range,
                bytes,
            });
        }
        Ok(validated)
    }
}

use std::collections::BTreeMap;

use aster_text::{FontFaceId, FontSelection, TextDirection, TextShapeError, TextShaper};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{ProjectRenderError, text_fonts::TextFontChain, text_style::ProjectTextStyle};

#[derive(Clone, Debug, Serialize)]
pub struct TextFontEvidence {
    pub family: String,
    pub face: FontFaceId,
    pub variations: Vec<([u8; 4], f32)>,
}

impl From<&FontSelection> for TextFontEvidence {
    fn from(selection: &FontSelection) -> Self {
        Self {
            family: selection.family.clone(),
            face: selection.face,
            variations: selection
                .variations
                .iter()
                .map(|(tag, value)| (*tag, *value))
                .collect(),
        }
    }
}

#[derive(Clone, Debug, clap::Args)]
pub(crate) struct TextCoverageConfig {
    #[arg(long, default_value_t = 1024)]
    max_text_coverage_entries: usize,
}

impl Default for TextCoverageConfig {
    fn default() -> Self {
        Self {
            max_text_coverage_entries: 1024,
        }
    }
}

pub(crate) struct TextFontCoverage {
    pub fonts: Vec<TextFontEvidence>,
    pub reason: Option<String>,
}

/// Coverage probes never allocate atlas images or confer native raster qualification.
pub(crate) struct TextCoverage {
    config: TextCoverageConfig,
    reasons: BTreeMap<String, Option<String>>,
}

impl TextCoverage {
    pub fn new(config: TextCoverageConfig) -> Result<Self, ProjectRenderError> {
        if config.max_text_coverage_entries == 0 || config.max_text_coverage_entries > 65536 {
            return Err(ProjectRenderError::Invalid(
                "text coverage cache limit".into(),
            ));
        }
        Ok(Self {
            config,
            reasons: BTreeMap::new(),
        })
    }

    pub fn inspect(
        &mut self,
        style: &ProjectTextStyle,
        locale: &str,
        chain: &TextFontChain,
        shaper: &TextShaper,
    ) -> Result<TextFontCoverage, ProjectRenderError> {
        let fonts = chain
            .selections
            .iter()
            .map(TextFontEvidence::from)
            .collect::<Vec<_>>();
        if chain.fonts.is_empty() {
            return Ok(TextFontCoverage {
                fonts,
                reason: chain.deferred.clone(),
            });
        }
        let key = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(
                &style.text,
                locale,
                &fonts,
                &chain.deferred
            ))?)
        );
        if !self.reasons.contains_key(&key) {
            let mut offset = 0;
            let mut reason = None;
            for part in style
                .text
                .split_inclusive(['\r', '\n', '\u{2028}', '\u{2029}'])
            {
                let line = part.trim_end_matches(['\r', '\n', '\u{2028}', '\u{2029}']);
                // Font and script coverage is independent of raster density and line wrapping.
                let result =
                    shaper.shape(line, 1., TextDirection::LeftToRight, locale, &chain.fonts);
                let error = match result {
                    Ok(_) => {
                        offset += part.encode_utf16().count() as u32;
                        continue;
                    }
                    Err(TextShapeError::MissingGlyph { start, end }) => {
                        TextShapeError::MissingGlyph {
                            start: start + offset,
                            end: end + offset,
                        }
                    }
                    Err(error @ TextShapeError::Unsupported(_)) => error,
                    Err(error) => return Err(error.into()),
                };
                reason = Some(format!(
                    "{error}{}",
                    chain
                        .deferred
                        .as_ref()
                        .map_or(String::new(), |r| format!("; {r}"))
                ));
                break;
            }
            if self.reasons.len() >= self.config.max_text_coverage_entries {
                self.reasons.clear();
            }
            self.reasons.insert(key.clone(), reason);
        }
        Ok(TextFontCoverage {
            fonts,
            reason: self.reasons.get(&key).cloned().ok_or_else(|| {
                ProjectRenderError::Invalid("font coverage cache entry absent".into())
            })?,
        })
    }
}

use std::collections::BTreeMap;

use aster_text::{
    FontFaceId, FontSelection, GlyphPaint, TextDirection, TextShapeError, TextShaper,
};
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
                &chain.deferred,
                &chain.raster_reason,
                style.font_size,
                style.stroke_width,
                style.animated,
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
                    Ok(shaped) => {
                        // Static authored paint probes qualify a capability reason, never native output.
                        if !style.animated
                            && style.font_size <= 4096.
                            && (style.font_size as f32) > 0.
                            && style.stroke_width <= 256.
                            && (style.stroke_width == 0. || (style.stroke_width as f32) > 0.)
                        {
                            let paint = if style.stroke_width > 0. {
                                GlyphPaint::Stroke {
                                    width: style.stroke_width as f32,
                                }
                            } else {
                                GlyphPaint::Fill
                            };
                            for glyph in &shaped.glyphs {
                                let font = chain
                                    .fonts
                                    .iter()
                                    .find(|f| f.matches_glyph(glyph))
                                    .ok_or_else(|| {
                                        ProjectRenderError::Invalid(
                                            "paint capability font absent".into(),
                                        )
                                    })?;
                                if let Some(limitation) = paint.limitation(
                                    font,
                                    glyph.glyph_id,
                                    style.font_size as f32,
                                    true,
                                )? {
                                    let digest = glyph
                                        .face
                                        .sha256
                                        .iter()
                                        .map(|v| format!("{v:02x}"))
                                        .collect::<String>();
                                    reason = Some(format!(
                                        "{limitation}; face {digest}#{} glyph {} at authored size {}",
                                        glyph.face.index, glyph.glyph_id, style.font_size
                                    ));
                                    break;
                                }
                            }
                            if reason.is_some() {
                                break;
                            }
                        }
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
            reason: self
                .reasons
                .get(&key)
                .cloned()
                .ok_or_else(|| {
                    ProjectRenderError::Invalid("font coverage cache entry absent".into())
                })?
                .or_else(|| chain.raster_reason.clone()),
        })
    }
}

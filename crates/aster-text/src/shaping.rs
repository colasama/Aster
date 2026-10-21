use std::sync::Arc;

use harfrust::{Buffer, Direction, Font, Script, ShapeOptions, ShaperFont, Tag};
use icu_segmenter::GraphemeClusterSegmenter;
use read_fonts::{FontRef, TableProvider};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{FontFaceId, FontSelection, LoadedFont};

#[derive(Clone, Debug, clap::Args)]
pub struct TextShapeConfig {
    #[arg(long, default_value_t = Self::default().max_text_codepoints)]
    pub max_text_codepoints: usize,
    #[arg(long, default_value_t = Self::default().max_shaped_glyphs)]
    pub max_shaped_glyphs: usize,
    #[arg(long, default_value_t = Self::default().max_fallback_faces)]
    pub max_fallback_faces: usize,
    #[arg(long, default_value_t = Self::default().max_layout_work)]
    pub max_layout_work: usize,
}

impl Default for TextShapeConfig {
    fn default() -> Self {
        Self {
            max_text_codepoints: 4096,
            max_shaped_glyphs: 65_536,
            max_fallback_faces: 16,
            max_layout_work: 1_048_576,
        }
    }
}

#[derive(Debug, Error)]
pub enum TextShapeError {
    #[error("text resource limit exceeded: {0}")]
    Limit(&'static str),
    #[error("invalid text input: {0}")]
    Invalid(&'static str),
    #[error("text requires retained rendering: {0}")]
    Unsupported(&'static str),
    #[error("no admitted fallback font covers UTF-16 interval {start}..{end}")]
    MissingGlyph { start: u32, end: u32 },
    #[error("native shaping failed: {0}")]
    Shaping(#[from] harfrust::ShapeError),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextDirection {
    #[default]
    LeftToRight,
    RightToLeft,
}

/// Owns an authenticated physical face at one complete variation location.
#[derive(Clone)]
pub struct NativeFont {
    pub(crate) selection: FontSelection,
    pub(crate) font: Font,
    pub(crate) data: Arc<[u8]>,
}

impl NativeFont {
    pub fn matches_glyph(&self, glyph: &PositionedGlyph) -> bool {
        self.selection.face == glyph.face
            && self
                .selection
                .variations
                .iter()
                .map(|(tag, value)| (*tag, *value))
                .eq(glyph.variations.iter().copied())
    }

    pub fn new(selection: FontSelection, bytes: LoadedFont) -> Result<Self, TextShapeError> {
        let hash: [u8; 32] = Sha256::digest(&bytes.data).into();
        if hash != bytes.sha256
            || hash != selection.face.sha256
            || selection.variations.len() > 64
            || selection.variations.values().any(|v| !v.is_finite())
        {
            return Err(TextShapeError::Invalid(
                "font content or variation identity",
            ));
        }
        let tables = FontRef::from_index(&bytes.data, selection.face.index)
            .map_err(|_| TextShapeError::Invalid("font face index"))?;
        let axes = match tables.fvar() {
            Ok(fvar) => fvar
                .axes()
                .map_err(|_| TextShapeError::Invalid("variation axes"))?
                .to_vec(),
            Err(read_fonts::ReadError::TableIsMissing(_)) => Vec::new(),
            Err(_) => return Err(TextShapeError::Invalid("variation axes")),
        };
        for (tag, value) in &selection.variations {
            let axis = axes
                .iter()
                .find(|axis| axis.axis_tag() == Tag::new(tag))
                .ok_or(TextShapeError::Invalid("unknown variation axis"))?;
            if *value < axis.min_value().to_f32() || *value > axis.max_value().to_f32() {
                return Err(TextShapeError::Invalid("variation coordinate outside axis"));
            }
        }
        let data = bytes.data;
        let source: Arc<dyn AsRef<[u8]> + Send + Sync> = Arc::new(Arc::clone(&data));
        let base =
            Font::new(source, selection.face.index).ok_or(TextShapeError::Invalid("font model"))?;
        let font = base
            .instance_builder()
            .variations(
                selection
                    .variations
                    .iter()
                    .map(|(tag, value)| (Tag::new(tag), *value)),
            )
            .build();
        if !(16..=16_384).contains(&font.units_per_em()) || font.num_glyphs() == 0 {
            return Err(TextShapeError::Invalid("font metrics"));
        }
        Ok(Self {
            selection,
            font,
            data,
        })
    }

    /// Canvas middle aligns the normalized typographic em box, quantized to layout units.
    pub fn middle_baseline_offset(&self, size: f64) -> Result<f64, TextShapeError> {
        let metrics = self.font.metrics();
        let line = metrics
            .typo_line
            .or(metrics.hhea_line)
            .ok_or(TextShapeError::Unsupported(
                "font has no horizontal line metrics",
            ))?;
        let ascent = line.ascender.to_f64();
        let descent = line.descender.to_f64();
        if !size.is_finite() || !(0.0..=4096.0).contains(&size) || ascent <= descent {
            return Err(TextShapeError::Invalid("font baseline metrics"));
        }
        Ok(((size * ascent / (ascent - descent) - size / 2.0) * 64.0).floor() / 64.0)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PositionedGlyph {
    pub face: FontFaceId,
    pub variations: Vec<([u8; 4], f32)>,
    pub glyph_id: u32,
    pub cluster_start: u32,
    pub cluster_end: u32,
    pub advance: [f64; 2],
    pub offset: [f64; 2],
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ShapedText {
    pub glyphs: Vec<PositionedGlyph>,
    pub advance: f64,
    pub middle_baseline_offset: f64,
}

pub struct TextShaper {
    pub(crate) config: TextShapeConfig,
}

impl TextShaper {
    pub fn new(config: TextShapeConfig) -> Result<Self, TextShapeError> {
        if config.max_text_codepoints == 0
            || config.max_text_codepoints > 4096
            || config.max_shaped_glyphs == 0
            || config.max_shaped_glyphs > 65_536
            || config.max_fallback_faces == 0
            || config.max_fallback_faces > 64
            || config.max_layout_work == 0
            || config.max_layout_work > 16_777_216
        {
            return Err(TextShapeError::Invalid("shaping limits"));
        }
        Ok(Self { config })
    }

    pub fn shape(
        &self,
        text: &str,
        size: f64,
        direction: TextDirection,
        language: &str,
        fonts: &[NativeFont],
    ) -> Result<ShapedText, TextShapeError> {
        if text.len() > self.config.max_text_codepoints * 4
            || text.chars().count() > self.config.max_text_codepoints
        {
            return Err(TextShapeError::Limit("input codepoints"));
        }
        if fonts.is_empty()
            || fonts.len() > self.config.max_fallback_faces
            || !size.is_finite()
            || size <= 0.0
            || size > 4096.0
            || language.is_empty()
            || language.len() > 64
            || !language.is_ascii()
        {
            return Err(TextShapeError::Invalid("font chain, size or language"));
        }
        let language: harfrust::Language = language
            .parse()
            .map_err(|_| TextShapeError::Invalid("language tag"))?;
        let boundaries: Vec<_> = GraphemeClusterSegmenter::new().segment_str(text).collect();
        let mut runs: Vec<(usize, usize, usize, Option<Script>)> = Vec::new();
        let mut utf16 = 0_u32;
        let mut probe = Buffer::new();
        probe.push_str(text);
        probe.guess_segment_properties();
        let mut previous_script = probe.script();
        // A run made only of strong RTL graphemes is independent of the paragraph base direction.
        // Mixed text and neutral boundaries still require a verified bidi itemizer.
        let pure_rtl = !text.is_empty()
            && boundaries.windows(2).all(|span| {
                let mut properties = Buffer::new();
                properties.push_str(&text[span[0]..span[1]]);
                properties.guess_segment_properties();
                properties.script().is_some() && properties.direction() == Direction::RightToLeft
            });
        let direction = if pure_rtl {
            TextDirection::RightToLeft
        } else {
            direction
        };
        if direction == TextDirection::RightToLeft && text.chars().any(char::is_numeric) {
            return Err(TextShapeError::Unsupported(
                "RTL numeric visual runs are not verified",
            ));
        }
        for span in boundaries.windows(2) {
            let grapheme = &text[span[0]..span[1]];
            let end = utf16 + grapheme.encode_utf16().count() as u32;
            let face = fonts
                .iter()
                .position(|font| {
                    let shaper = ShaperFont::new(&font.font);
                    grapheme.chars().all(|ch| {
                        matches!(ch as u32, 0x200c..=0x200d | 0xfe00..=0xfe0f | 0xe0100..=0xe01ef)
                            || shaper.nominal_glyph(ch as u32).is_some()
                    })
                })
                .ok_or(TextShapeError::MissingGlyph { start: utf16, end })?;
            let mut properties = Buffer::new();
            properties.push_str(grapheme);
            properties.guess_segment_properties();
            let script = properties.script().or(previous_script);
            let guessed = properties.direction();
            if (guessed == Direction::RightToLeft && direction == TextDirection::LeftToRight)
                || (guessed == Direction::LeftToRight
                    && direction == TextDirection::RightToLeft
                    && properties.script().is_some())
            {
                return Err(TextShapeError::Unsupported(
                    "bidirectional paragraph requires independently verified visual runs",
                ));
            }
            if let Some(last) = runs
                .last_mut()
                .filter(|run| run.2 == face && run.3 == script)
            {
                last.1 = span[1];
            } else {
                runs.push((span[0], span[1], face, script));
            }
            previous_script = script;
            utf16 = end;
        }
        if direction == TextDirection::RightToLeft {
            runs.reverse();
        }
        let mut result = ShapedText {
            glyphs: Vec::new(),
            advance: 0.0,
            middle_baseline_offset: fonts[0].middle_baseline_offset(size)?,
        };
        for (start, end, face, script) in runs {
            let font = &fonts[face];
            let base = text[..start].encode_utf16().count() as u32;
            let end_utf16 = base + text[start..end].encode_utf16().count() as u32;
            let mut buffer = Buffer::new();
            let mut cluster = base;
            for ch in text[start..end].chars() {
                buffer.push(ch as u32, cluster);
                cluster += ch.len_utf16() as u32;
            }
            buffer.set_pre_context(&text[..start]);
            buffer.set_post_context(&text[end..]);
            buffer.set_script(script);
            buffer.set_language(Some(language.clone()));
            buffer.set_direction(match direction {
                TextDirection::LeftToRight => Direction::LeftToRight,
                TextDirection::RightToLeft => Direction::RightToLeft,
            });
            let shaper = ShaperFont::new(&font.font);
            harfrust::shape(&shaper, &mut buffer, ShapeOptions::default())?;
            if !buffer.allocation_successful()
                || buffer.len()
                    > self
                        .config
                        .max_shaped_glyphs
                        .saturating_sub(result.glyphs.len())
            {
                return Err(TextShapeError::Limit(
                    "shaping expansion or operation budget",
                ));
            }
            let mut ends: Vec<_> = buffer.glyph_infos().iter().map(|g| g.cluster).collect();
            ends.push(end_utf16);
            ends.sort_unstable();
            ends.dedup();
            let scale = size / f64::from(font.font.units_per_em());
            for (info, position) in buffer.glyph_infos().iter().zip(buffer.glyph_positions()) {
                if info.glyph_id == 0 {
                    return Err(TextShapeError::MissingGlyph {
                        start: info.cluster,
                        end: end_utf16,
                    });
                }
                let cluster_end = ends
                    .get(ends.partition_point(|value| *value <= info.cluster))
                    .copied()
                    .ok_or(TextShapeError::Invalid("shaped cluster interval"))?;
                let advance = [
                    f64::from(position.x_advance) * scale,
                    -f64::from(position.y_advance) * scale,
                ];
                result.advance += advance[0];
                result.glyphs.push(PositionedGlyph {
                    face: font.selection.face,
                    variations: font
                        .selection
                        .variations
                        .iter()
                        .map(|(tag, value)| (*tag, *value))
                        .collect(),
                    glyph_id: info.glyph_id,
                    cluster_start: info.cluster,
                    cluster_end,
                    advance,
                    offset: [
                        f64::from(position.x_offset) * scale,
                        -f64::from(position.y_offset) * scale,
                    ],
                });
            }
        }
        Ok(result)
    }
}

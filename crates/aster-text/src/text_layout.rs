use std::collections::BTreeMap;

use icu_segmenter::{GraphemeClusterSegmenter, WordSegmenter};
use serde::{Deserialize, Serialize};

use crate::{NativeFont, ShapedText, TextDirection, TextShapeConfig, TextShapeError, TextShaper};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextAlignment {
    #[default]
    Left,
    Center,
    Right,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextLayoutRequest {
    pub text: String,
    pub width: f64,
    pub height: f64,
    pub font_size: f64,
    pub tracking: f64,
    pub leading: f64,
    pub alignment: TextAlignment,
    pub direction: TextDirection,
    pub language: String,
    pub per_grapheme: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayoutLine {
    pub text: String,
    pub width: f64,
    /// Canvas middle baseline anchor, before text animator transforms.
    pub origin: [f64; 2],
    pub fragments: Vec<LayoutFragment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct LayoutFragment {
    pub text: String,
    pub x: f64,
    pub shaped: ShapedText,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextLayoutResult {
    pub lines: Vec<LayoutLine>,
    pub work_codepoints: usize,
}

/// Reproduces the production word-wrap decisions, including first-token overflow and trimming.
pub struct TextLayout {
    shaper: TextShaper,
}

struct LayoutMeasurements {
    values: BTreeMap<String, ShapedText>,
    work: usize,
    cached_glyphs: usize,
}

impl TextLayout {
    pub fn new(config: TextShapeConfig) -> Result<Self, TextShapeError> {
        Ok(Self {
            shaper: TextShaper::new(config)?,
        })
    }

    pub fn evaluate(
        &self,
        request: &TextLayoutRequest,
        fonts: &[NativeFont],
    ) -> Result<TextLayoutResult, TextShapeError> {
        if request.text.len() > self.shaper.config.max_text_codepoints * 4
            || request.text.chars().count() > self.shaper.config.max_text_codepoints
        {
            return Err(TextShapeError::Limit("layout text"));
        }
        if [
            request.width,
            request.height,
            request.font_size,
            request.tracking,
            request.leading,
        ]
        .iter()
        .any(|v| !v.is_finite())
            || request.width <= 0.0
            || request.height <= 0.0
            || request.width > 1_048_576.0
            || request.height > 1_048_576.0
            || request.font_size <= 0.0
            || request.font_size > 4096.0
            || request.tracking.abs() > 65_536.0
            || request.leading.abs() > 65_536.0
        {
            return Err(TextShapeError::Invalid("layout dimensions"));
        }
        let mut measurements = LayoutMeasurements {
            values: BTreeMap::new(),
            work: 0,
            cached_glyphs: 0,
        };
        // Validate the font and language even for an empty text block.
        measurements.shape("", request, fonts, &self.shaper)?;
        let maximum = request.width * 0.94;
        let mut wrapped = Vec::new();
        let words = WordSegmenter::new_auto(Default::default());
        let mut hard_lines = request.text.split('\n').peekable();
        while let Some(hard) = hard_lines.next() {
            // Only CR immediately before LF is removed; a final lone CR is ordinary whitespace.
            let hard = if hard.ends_with('\r') && hard_lines.peek().is_some() {
                &hard[..hard.len() - 1]
            } else {
                hard
            };
            if hard.is_empty() {
                wrapped.push(String::new());
                continue;
            }
            let points: Vec<_> = words.segment_str(hard).collect();
            let mut line = String::new();
            for span in points.windows(2) {
                let token = &hard[span[0]..span[1]];
                let candidate = format!("{line}{token}");
                if line.is_empty()
                    || measurements.width(&candidate, request, fonts, &self.shaper)? <= maximum
                {
                    line = candidate;
                    continue;
                }
                wrapped.push(line.trim_end_matches(Self::is_ecma_space).to_owned());
                line = token.trim_start_matches(Self::is_ecma_space).to_owned();
                if measurements.width(&line, request, fonts, &self.shaper)? <= maximum {
                    continue;
                }
                let remaining = std::mem::take(&mut line);
                let points: Vec<_> = GraphemeClusterSegmenter::new()
                    .segment_str(&remaining)
                    .collect();
                for span in points.windows(2) {
                    let cluster = &remaining[span[0]..span[1]];
                    let candidate = format!("{line}{cluster}");
                    if !line.is_empty()
                        && measurements.width(&candidate, request, fonts, &self.shaper)? > maximum
                    {
                        wrapped.push(line);
                        line = cluster.to_owned();
                    } else {
                        line = candidate;
                    }
                }
            }
            wrapped.push(line.trim_end_matches(Self::is_ecma_space).to_owned());
        }
        let block_height =
            request.font_size + wrapped.len().saturating_sub(1) as f64 * request.leading;
        let baseline = (request.height - block_height) / 2.0 + request.font_size / 2.0;
        let mut lines = Vec::with_capacity(wrapped.len());
        let mut output_glyphs = 0_usize;
        for (index, text) in wrapped.into_iter().enumerate() {
            let width = measurements.width(&text, request, fonts, &self.shaper)?;
            let x = request.width * 0.03
                + match request.alignment {
                    TextAlignment::Left => 0.0,
                    TextAlignment::Right => maximum - width,
                    TextAlignment::Center => (maximum - width) / 2.0,
                };
            let mut fragments = Vec::new();
            if request.per_grapheme || request.tracking.abs() >= 0.000_01 {
                let points: Vec<_> = GraphemeClusterSegmenter::new().segment_str(&text).collect();
                let mut x = 0.0;
                for span in points.windows(2) {
                    let text = text[span[0]..span[1]].to_owned();
                    let shaped = measurements.shape(&text, request, fonts, &self.shaper)?;
                    output_glyphs = output_glyphs
                        .checked_add(shaped.glyphs.len())
                        .filter(|count| *count <= self.shaper.config.max_shaped_glyphs)
                        .ok_or(TextShapeError::Limit("layout output glyphs"))?;
                    let shaped = shaped.clone();
                    let advance = shaped.advance;
                    fragments.push(LayoutFragment { text, x, shaped });
                    x += advance + request.tracking;
                }
            } else if !text.is_empty() {
                let shaped = measurements.shape(&text, request, fonts, &self.shaper)?;
                output_glyphs = output_glyphs
                    .checked_add(shaped.glyphs.len())
                    .filter(|count| *count <= self.shaper.config.max_shaped_glyphs)
                    .ok_or(TextShapeError::Limit("layout output glyphs"))?;
                let shaped = shaped.clone();
                fragments.push(LayoutFragment {
                    text: text.clone(),
                    x: 0.0,
                    shaped,
                });
            }
            lines.push(LayoutLine {
                text,
                width,
                origin: [x, baseline + index as f64 * request.leading],
                fragments,
            });
        }
        Ok(TextLayoutResult {
            lines,
            work_codepoints: measurements.work,
        })
    }

    fn is_ecma_space(ch: char) -> bool {
        matches!(ch, '\u{9}'..='\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' |
            '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    }
}

impl LayoutMeasurements {
    fn shape(
        &mut self,
        text: &str,
        request: &TextLayoutRequest,
        fonts: &[NativeFont],
        shaper: &TextShaper,
    ) -> Result<&ShapedText, TextShapeError> {
        if !self.values.contains_key(text) {
            self.work = self
                .work
                .checked_add(text.chars().count().max(1))
                .filter(|work| *work <= shaper.config.max_layout_work)
                .ok_or(TextShapeError::Limit("layout measurement work"))?;
            let shaped = shaper.shape(
                text,
                request.font_size,
                request.direction,
                &request.language,
                fonts,
            )?;
            self.cached_glyphs = self
                .cached_glyphs
                .checked_add(shaped.glyphs.len())
                .filter(|count| *count <= shaper.config.max_shaped_glyphs)
                .ok_or(TextShapeError::Limit("layout cached glyphs"))?;
            self.values.insert(text.to_owned(), shaped);
        }
        self.values
            .get(text)
            .ok_or(TextShapeError::Invalid("layout measurement cache"))
    }

    fn width(
        &mut self,
        text: &str,
        request: &TextLayoutRequest,
        fonts: &[NativeFont],
        shaper: &TextShaper,
    ) -> Result<f64, TextShapeError> {
        if request.tracking.abs() < 0.000_01 {
            return Ok(self.shape(text, request, fonts, shaper)?.advance);
        }
        let points: Vec<_> = GraphemeClusterSegmenter::new().segment_str(text).collect();
        let mut width = 0.0;
        for span in points.windows(2) {
            width += self
                .shape(&text[span[0]..span[1]], request, fonts, shaper)?
                .advance;
        }
        Ok(width + points.len().saturating_sub(2) as f64 * request.tracking)
    }
}

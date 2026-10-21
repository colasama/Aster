use crate::ProjectRenderError;
use aster_eval::{TextLayoutUnit, TextUnitContext};
use icu_segmenter::{GraphemeClusterSegmenter, WordSegmenter};

pub(crate) struct NativeTextUnits;

impl NativeTextUnits {
    pub fn segment(text: &str) -> Result<Vec<TextLayoutUnit>, ProjectRenderError> {
        if text.chars().count() > 4096 {
            return Err(ProjectRenderError::Invalid(
                "text selector domain exceeds budget".into(),
            ));
        }
        let boundaries = GraphemeClusterSegmenter::new()
            .segment_str(text)
            .collect::<Vec<_>>();
        let mut spans = Vec::new();
        let mut lines = vec![0];
        for span in boundaries.windows(2) {
            let segment = &text[span[0]..span[1]];
            if matches!(segment, "\r\n" | "\r" | "\n" | "\u{2028}" | "\u{2029}") {
                lines.push(span[1]);
            } else {
                spans.push((span[0], span[1]));
            }
        }
        let mut words = Vec::new();
        let mut start = 0;
        for (end, kind) in WordSegmenter::new_auto(Default::default())
            .segment_str(text)
            .iter_with_word_type()
        {
            if kind.is_word_like() {
                words.push((start, end));
            }
            start = end;
        }
        let whitespace = |s: &str| {
            s.chars().all(|ch| matches!(ch,'\u{9}'..='\u{d}'|' '| '\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
        };
        let without_spaces = spans
            .iter()
            .filter(|(a, b)| !whitespace(&text[*a..*b]))
            .count() as u32;
        let mut utf16 = vec![0; text.len() + 1];
        let mut offset = 0;
        for (byte, ch) in text.char_indices() {
            utf16[byte] = offset;
            offset += ch.len_utf16();
            utf16[byte + ch.len_utf8()] = offset;
        }
        let mut word = 0;
        let mut excluding = 0;
        let mut result = Vec::new();
        for (index, (start, end)) in spans.iter().copied().enumerate() {
            while words.get(word).is_some_and(|(_, end)| *end <= start) {
                word += 1;
            }
            let is_whitespace = whitespace(&text[start..end]);
            let excluding_index = if is_whitespace {
                None
            } else {
                let index = excluding;
                excluding += 1;
                Some(index)
            };
            let word_index = if words
                .get(word)
                .is_some_and(|(a, b)| start >= *a && start < *b)
            {
                word
            } else {
                word.saturating_sub(1).min(words.len().saturating_sub(1))
            };
            result.push(TextLayoutUnit {
                text: text[start..end].into(),
                source_start: utf16[start],
                source_end: utf16[end],
                code_point: text[start..end]
                    .chars()
                    .next()
                    .map_or(65533., |ch| u32::from(ch) as f64),
                context: TextUnitContext {
                    character_index: index as u32,
                    character_count: spans.len() as u32,
                    character_excluding_spaces_index: excluding_index,
                    character_excluding_spaces_count: without_spaces,
                    word_index: word_index as u32,
                    word_count: words.len() as u32,
                    line_index: lines.partition_point(|n| *n <= start).saturating_sub(1) as u32,
                    line_count: lines.len() as u32,
                    is_whitespace,
                },
            });
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::NativeTextUnits;

    #[test]
    fn selector_units_preserve_utf16_graphemes_words_and_ecma_spaces()
    -> Result<(), Box<dyn std::error::Error>> {
        let units = NativeTextUnits::segment("A\u{301} 🙂\r\nB\u{feff}C")?;
        assert_eq!(
            units.iter().map(|u| u.text.as_str()).collect::<Vec<_>>(),
            vec!["A\u{301}", " ", "🙂", "B", "\u{feff}", "C"]
        );
        assert_eq!(
            units
                .iter()
                .map(|u| (u.source_start, u.source_end))
                .collect::<Vec<_>>(),
            vec![(0, 2), (2, 3), (3, 5), (7, 8), (8, 9), (9, 10)]
        );
        assert_eq!(units[3].context.line_index, 1);
        assert_eq!(units[0].context.line_count, 2);
        assert_eq!(units[0].context.character_excluding_spaces_count, 4);
        assert_eq!(units[4].context.character_excluding_spaces_index, None);
        assert_eq!(units[5].context.character_excluding_spaces_index, Some(3));
        assert!(NativeTextUnits::segment(&"A".repeat(4097)).is_err());
        Ok(())
    }
}

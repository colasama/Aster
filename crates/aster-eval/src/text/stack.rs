use super::{
    TextBaseStyle, TextCharacter, TextLimits, TextSelectorFrame, TextSelectorTrack, TextTrack,
    TextUnitContext,
    properties::{PropertyFrame, PropertyTracks},
};
use crate::{EvaluationError, EvaluationLimits, ExpressionLimits};
use aster_types::editor::{TextAnimator, TextSelector};
use std::collections::BTreeSet;

#[derive(Clone, Debug)]
pub struct TextAnimatorTrack {
    enabled: bool,
    groups: Vec<GroupTrack>,
    time_bounds: [f64; 2],
    dynamic_selector: bool,
    pub(super) unit_limit: usize,
}
#[derive(Clone, Debug)]
struct GroupTrack {
    seed: f64,
    selectors: Vec<TextSelectorTrack>,
    properties: PropertyTracks,
}
#[derive(Clone, Debug)]
struct GroupFrame {
    seed: f64,
    selectors: Vec<TextSelectorFrame>,
    properties: PropertyFrame,
}
#[derive(Clone, Debug)]
pub struct TextAnimatorFrame {
    groups: Vec<GroupFrame>,
    unit_limit: usize,
}

impl TextAnimatorTrack {
    pub fn compile(
        settings: &TextAnimator,
        limits: &TextLimits,
        evaluation: &EvaluationLimits,
        expressions: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        if settings.groups.len() > limits.max_text_groups.min(32) {
            return Err(EvaluationError::InvalidScene(
                "text group budget exceeded".into(),
            ));
        }
        let mut result = Self {
            enabled: settings.enabled,
            groups: Vec::new(),
            time_bounds: [f64::INFINITY, f64::NEG_INFINITY],
            dynamic_selector: false,
            unit_limit: limits.max_text_units.min(4096),
        };
        let mut ids = BTreeSet::new();
        for group in &settings.groups {
            TextTrack::identifier(&group.id)?;
            if !ids.insert(&group.id)
                || group.name.trim().is_empty()
                || group.name.encode_utf16().count() > 128
                || group.selectors.len() > limits.max_text_selectors.min(32)
            {
                return Err(EvaluationError::InvalidScene(
                    "invalid text animator group".into(),
                ));
            }
            let mut selector_ids = BTreeSet::new();
            let mut selectors = Vec::with_capacity(group.selectors.len());
            for selector in &group.selectors {
                let common = match selector {
                    TextSelector::Range {
                        common,
                        start,
                        end,
                        offset,
                        smoothness,
                        ease_high,
                        ease_low,
                        ..
                    } => {
                        if group.enabled && common.enabled {
                            for track in [
                                &common.amount,
                                start,
                                end,
                                offset,
                                smoothness,
                                ease_high,
                                ease_low,
                            ] {
                                TextTrack::time_bounds(track, &mut result.time_bounds);
                            }
                        }
                        common
                    }
                    TextSelector::Expression { common, .. }
                    | TextSelector::Wiggly { common, .. } => {
                        result.dynamic_selector |= group.enabled && common.enabled;
                        common
                    }
                };
                if !selector_ids.insert(&common.id) {
                    return Err(EvaluationError::InvalidScene(
                        "duplicate text selector identity".into(),
                    ));
                }
                selectors.push(TextSelectorTrack::compile(
                    selector,
                    evaluation,
                    expressions,
                )?);
            }
            let properties = PropertyTracks::compile(&group.properties, evaluation)?;
            let seed = TextTrack::seed(&group.random_seed)?;
            if group.enabled {
                PropertyTracks::time_bounds(&group.properties, &mut result.time_bounds);
                result.groups.push(GroupTrack {
                    seed,
                    selectors,
                    properties,
                });
            }
        }
        Ok(result)
    }

    pub fn cache_time(&self, local_time: f64) -> Option<f64> {
        if !self.enabled {
            return None;
        }
        let time = if local_time.is_finite() {
            local_time
        } else {
            0.0
        };
        if self.dynamic_selector {
            return Some(time);
        }
        if self.time_bounds.iter().all(|v| v.is_finite()) {
            Some(time.clamp(self.time_bounds[0], self.time_bounds[1]))
        } else {
            None
        }
    }

    pub fn evaluate(&self, time: f64) -> Result<TextAnimatorFrame, EvaluationError> {
        let time = if time.is_finite() { time } else { 0.0 };
        let mut groups = Vec::with_capacity(self.groups.len());
        if self.enabled {
            for group in &self.groups {
                groups.push(GroupFrame {
                    seed: group.seed,
                    selectors: group
                        .selectors
                        .iter()
                        .map(|s| s.evaluate(time))
                        .collect::<Result<_, _>>()?,
                    properties: group.properties.evaluate(time)?,
                });
            }
        }
        Ok(TextAnimatorFrame {
            groups,
            unit_limit: self.unit_limit,
        })
    }
}

impl TextAnimatorFrame {
    pub fn character(
        &self,
        unit: &TextUnitContext,
        base: &TextBaseStyle,
        expressions: bool,
    ) -> Result<TextCharacter, EvaluationError> {
        // Layout segmentation is supplied by the raster boundary; reject invalid domains before integer noise arithmetic.
        if unit.character_count as usize > self.unit_limit
            || unit.character_index >= unit.character_count
            || unit.character_excluding_spaces_count > unit.character_count
            || unit
                .character_excluding_spaces_index
                .is_some_and(|i| i >= unit.character_excluding_spaces_count)
            || (unit.word_count > 0 && unit.word_index >= unit.word_count)
            || unit.line_count == 0
            || unit.line_index >= unit.line_count
        {
            return Err(EvaluationError::InvalidScene(
                "invalid text layout domain".into(),
            ));
        }
        let mut result = TextCharacter::new(base);
        for group in &self.groups {
            let amount = if group.selectors.is_empty() {
                1.0
            } else {
                TextSelectorFrame::combine(&group.selectors, unit, group.seed, expressions)
            };
            result.apply(&group.properties, amount);
        }
        result.finish();
        Ok(result)
    }
}

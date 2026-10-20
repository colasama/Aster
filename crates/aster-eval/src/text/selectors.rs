mod evaluate;
use super::{TextTrack, TextUnitContext, math::TextMath};
use crate::{
    EvaluationError, EvaluationLimits, ExpressionLimits, ScalarTrack, TextExpressionBinding,
    TextExpressionContext,
};
use aster_types::editor::{TextSelector, TextSelectorCommon};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct TextSelectorTrack {
    id_hash: f64,
    enabled: bool,
    mode: String,
    based_on: String,
    amount: ScalarTrack,
    kind: SelectorTrackKind,
}
#[derive(Clone, Debug)]
enum SelectorTrackKind {
    Range {
        tracks: Vec<ScalarTrack>,
        shape: String,
        percentage: bool,
        randomize: bool,
        seed: f64,
    },
    Wiggly {
        tracks: Vec<ScalarTrack>,
        seed: f64,
    },
    Expression {
        program: Arc<TextExpressionBinding>,
        offset: Option<ScalarTrack>,
    },
}

#[derive(Clone, Debug)]
pub struct TextSelectorFrame {
    id_hash: f64,
    time: f64,
    enabled: bool,
    mode: String,
    based_on: String,
    amount: f64,
    kind: SelectorKind,
}
#[derive(Clone, Debug)]
enum SelectorKind {
    Range {
        values: [f64; 6],
        shape: String,
        percentage: bool,
        randomize: bool,
        seed: f64,
    },
    Wiggly {
        values: [f64; 6],
        seed: f64,
    },
    Expression {
        program: Arc<TextExpressionBinding>,
        offset: f64,
    },
}

impl TextSelectorTrack {
    pub fn compile(
        selector: &TextSelector,
        limits: &EvaluationLimits,
        expressions: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        let (common, kind) = match selector {
            TextSelector::Range {
                common,
                units,
                start,
                end,
                offset,
                shape,
                smoothness,
                ease_high,
                ease_low,
                randomize_order,
                random_seed,
                ..
            } => {
                if !["percentage", "index"].contains(&units.as_str())
                    || ![
                        "square", "rampUp", "rampDown", "triangle", "round", "smooth",
                    ]
                    .contains(&shape.as_str())
                {
                    return Err(EvaluationError::InvalidScene(
                        "unsupported text range selector".into(),
                    ));
                }
                let tracks = [
                    (start, [-1e6, 1e6]),
                    (end, [-1e6, 1e6]),
                    (offset, [-1e6, 1e6]),
                    (smoothness, [0.0, 100.0]),
                    (ease_low, [-100.0, 100.0]),
                    (ease_high, [-100.0, 100.0]),
                ]
                .into_iter()
                .map(|(p, b)| TextTrack::compile(p, b, limits))
                .collect::<Result<_, _>>()?;
                (
                    common,
                    SelectorTrackKind::Range {
                        tracks,
                        shape: shape.clone(),
                        percentage: units == "percentage",
                        randomize: *randomize_order,
                        seed: TextTrack::seed(random_seed)?,
                    },
                )
            }
            TextSelector::Wiggly {
                common,
                minimum_amount,
                maximum_amount,
                wiggles_per_second,
                correlation,
                temporal_phase,
                spatial_phase,
                random_seed,
                ..
            } => {
                let tracks = [
                    (minimum_amount, [-100.0, 100.0]),
                    (maximum_amount, [-100.0, 100.0]),
                    (wiggles_per_second, [0.0, 100.0]),
                    (correlation, [0.0, 100.0]),
                    (temporal_phase, [-1e6, 1e6]),
                    (spatial_phase, [-1e6, 1e6]),
                ]
                .into_iter()
                .map(|(p, b)| TextTrack::compile(p, b, limits))
                .collect::<Result<_, _>>()?;
                let seed = TextTrack::seed(random_seed)?;
                (common, SelectorTrackKind::Wiggly { tracks, seed })
            }
            TextSelector::Expression {
                common,
                expression,
                time_offset,
                ..
            } => (
                common,
                SelectorTrackKind::Expression {
                    program: Arc::new(TextExpressionBinding::compile(expression, expressions)),
                    offset: time_offset
                        .value()
                        .map(|p| TextTrack::compile(p, [-1e6, 1e6], limits))
                        .transpose()?,
                },
            ),
        };
        Self::validate_common(common)?;
        Ok(Self {
            id_hash: f64::from(TextMath::hash(&common.id)),
            enabled: common.enabled,
            mode: common.mode.clone(),
            based_on: common.based_on.clone(),
            amount: TextTrack::compile(&common.amount, [-100.0, 100.0], limits)?,
            kind,
        })
    }

    fn validate_common(common: &TextSelectorCommon) -> Result<(), EvaluationError> {
        TextTrack::identifier(&common.id)?;
        if common.name.trim().is_empty()
            || common.name.encode_utf16().count() > 128
            || !["add", "subtract", "intersect", "min", "max", "difference"]
                .contains(&common.mode.as_str())
            || !["characters", "charactersExcludingSpaces", "words", "lines"]
                .contains(&common.based_on.as_str())
        {
            return Err(EvaluationError::InvalidScene(
                "invalid text selector metadata".into(),
            ));
        }
        Ok(())
    }

    pub fn evaluate(&self, time: f64) -> Result<TextSelectorFrame, EvaluationError> {
        let time = if time.is_finite() { time } else { 0.0 };
        let kind = match &self.kind {
            SelectorTrackKind::Range {
                tracks,
                shape,
                percentage,
                randomize,
                seed,
            } => SelectorKind::Range {
                values: Self::values(tracks, time)?,
                shape: shape.clone(),
                percentage: *percentage,
                randomize: *randomize,
                seed: *seed,
            },
            SelectorTrackKind::Wiggly { tracks, seed } => SelectorKind::Wiggly {
                values: Self::values(tracks, time)?,
                seed: *seed,
            },
            SelectorTrackKind::Expression { program, offset } => SelectorKind::Expression {
                program: Arc::clone(program),
                offset: offset
                    .as_ref()
                    .map(|p| p.evaluate(time))
                    .transpose()?
                    .unwrap_or(0.0),
            },
        };
        Ok(TextSelectorFrame {
            id_hash: self.id_hash,
            time,
            enabled: self.enabled,
            mode: self.mode.clone(),
            based_on: self.based_on.clone(),
            amount: self.amount.evaluate(time)?,
            kind,
        })
    }

    fn values(tracks: &[ScalarTrack], time: f64) -> Result<[f64; 6], EvaluationError> {
        let mut values = [0.0; 6];
        for (out, track) in values.iter_mut().zip(tracks) {
            *out = track.evaluate(time)?;
        }
        Ok(values)
    }
}

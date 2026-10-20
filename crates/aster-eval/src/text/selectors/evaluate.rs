use super::{SelectorKind, TextExpressionContext, TextMath, TextSelectorFrame, TextUnitContext};

impl TextSelectorFrame {
    pub fn combine(
        selectors: &[Self],
        unit: &TextUnitContext,
        animator_seed: f64,
        evaluate_expressions: bool,
    ) -> f64 {
        let mut combined = 0.0;
        let mut evaluated = false;
        for selector in selectors {
            if !selector.enabled {
                continue;
            }
            if !evaluated {
                combined = if ["subtract", "intersect", "min"].contains(&selector.mode.as_str()) {
                    1.0
                } else {
                    0.0
                };
            }
            let value = selector.weight(
                unit,
                animator_seed,
                if evaluated { combined * 100.0 } else { 100.0 },
                evaluate_expressions,
            );
            combined = match selector.mode.as_str() {
                "add" => (combined + value).clamp(-1.0, 1.0),
                "subtract" => (combined - value).clamp(-1.0, 1.0),
                "intersect" => combined * value,
                "min" => {
                    if combined.is_nan() || value.is_nan() {
                        f64::NAN
                    } else {
                        combined.min(value)
                    }
                }
                "max" => {
                    if combined.is_nan() || value.is_nan() {
                        f64::NAN
                    } else {
                        combined.max(value)
                    }
                }
                "difference" => (combined - value).abs(),
                _ => 0.0,
            };
            evaluated = true;
        }
        combined.clamp(-1.0, 1.0)
    }

    pub fn weight(
        &self,
        unit: &TextUnitContext,
        animator_seed: f64,
        selector_value: f64,
        evaluate_expressions: bool,
    ) -> f64 {
        let domain = match self.based_on.as_str() {
            "characters" => Some((unit.character_index, unit.character_count)),
            "charactersExcludingSpaces" => {
                if unit.is_whitespace {
                    None
                } else {
                    unit.character_excluding_spaces_index
                        .map(|index| (index, unit.character_excluding_spaces_count))
                }
            }
            "words" => Some((unit.word_index, unit.word_count)),
            "lines" => Some((unit.line_index, unit.line_count)),
            _ => None,
        };
        let Some((index, count)) = domain.filter(|(_, count)| *count > 0) else {
            return 0.0;
        };
        let amount = TextMath::bounded(self.amount, -100.0, 100.0, 100.0) / 100.0;
        match &self.kind {
            SelectorKind::Range {
                values,
                shape,
                percentage,
                randomize,
                seed,
            } => {
                let seed = if *seed != 0.0 { *seed } else { animator_seed };
                let index = if *randomize {
                    TextMath::randomized_index(index, count, seed)
                } else {
                    f64::from(index)
                };
                Self::range(*values, shape, *percentage, index, f64::from(count)) * amount
            }
            SelectorKind::Wiggly { values, seed } => {
                let seed = if *seed != 0.0 {
                    *seed
                } else if animator_seed != 0.0 {
                    animator_seed
                } else {
                    self.id_hash
                };
                let [
                    minimum,
                    maximum,
                    rate,
                    correlation,
                    temporal_phase,
                    spatial_phase,
                ] = *values;
                let temporal =
                    self.time * TextMath::bounded(rate, 0.0, 100.0, 2.0) + temporal_phase;
                let lower = temporal.floor();
                let mix = TextMath::smooth(temporal - lower);
                let common = TextMath::interpolate_noise(seed, lower, mix, 0.0);
                let spatial = f64::from(index) / f64::from(count.max(1)) * spatial_phase;
                let individual =
                    TextMath::interpolate_noise(seed, lower, mix, f64::from(index) + spatial);
                let correlation = TextMath::bounded(correlation, 0.0, 100.0, 0.0) / 100.0;
                let noise = individual * (1.0 - correlation) + common * correlation;
                let minimum = TextMath::bounded(minimum, -100.0, 100.0, -100.0) / 100.0;
                let maximum = TextMath::bounded(maximum, -100.0, 100.0, 100.0) / 100.0;
                (minimum + (maximum - minimum) * noise) * amount
            }
            SelectorKind::Expression { program, offset } => {
                let selector_value = TextMath::bounded(selector_value, -100.0, 100.0, 100.0);
                let value = if evaluate_expressions {
                    program.evaluate_or_fallback(TextExpressionContext {
                        time: self.time - offset,
                        text_index: f64::from(index) + 1.0,
                        text_total: f64::from(count),
                        selector_value,
                    })
                } else {
                    selector_value
                };
                (TextMath::bounded(value, -100.0, 100.0, selector_value) / 100.0) * amount
            }
        }
    }

    fn range(values: [f64; 6], shape: &str, percentage: bool, index: f64, count: f64) -> f64 {
        let [start, end, offset, smoothness, ease_low, ease_high] = values;
        let position = if percentage {
            ((index + 0.5) / count) * 100.0
        } else {
            index + 0.5
        };
        let domain = if percentage { 100.0 } else { count };
        let start = start + offset;
        let end = end + offset;
        let reversed = start > end;
        let low = start.min(end);
        let high = start.max(end);
        let span = (high - low).max(f64::EPSILON);
        let wrapped = position + TextMath::round(((low + high) * 0.5 - position) / domain) * domain;
        let progress = ((wrapped - low) / span).clamp(0.0, 1.0);
        let mut value = match shape {
            "square" => Self::square(wrapped, low, high, smoothness, domain),
            "rampUp" => progress,
            "rampDown" => 1.0 - progress,
            "triangle" => 1.0 - (progress * 2.0 - 1.0).abs(),
            "round" => {
                let centered = progress * 2.0 - 1.0;
                (1.0 - centered * centered).max(0.0).sqrt()
            }
            "smooth" => TextMath::smooth(progress) * TextMath::smooth(1.0 - progress) * 4.0,
            _ => 0.0,
        };
        if wrapped < low || wrapped > high {
            value = 0.0;
        }
        if reversed {
            value = 1.0 - value;
        }
        let value = value.clamp(0.0, 1.0);
        if value <= 0.0 || value >= 1.0 {
            return value;
        }
        let low_power = 2.0f64.powf(TextMath::bounded(ease_low, -100.0, 100.0, 0.0) / 100.0);
        let high_power = 2.0f64.powf(TextMath::bounded(ease_high, -100.0, 100.0, 0.0) / 100.0);
        let low = value.powf(low_power);
        let high = 1.0 - (1.0 - value).powf(high_power);
        (low * (1.0 - value) + high * value).clamp(0.0, 1.0)
    }

    fn square(position: f64, low: f64, high: f64, smoothness: f64, domain: f64) -> f64 {
        if position < low || position > high {
            return 0.0;
        }
        let feather = (TextMath::bounded(smoothness, 0.0, 100.0, 100.0) / 100.0) * domain * 0.5;
        if feather <= f64::EPSILON {
            return 1.0;
        }
        let span = (high - low).max(f64::EPSILON);
        let peak = TextMath::smooth((span / (2.0 * feather)).min(1.0));
        (TextMath::smooth((position - low) / feather)
            * TextMath::smooth((high - position) / feather))
            / (peak * peak)
    }
}

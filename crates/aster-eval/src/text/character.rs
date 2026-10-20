use super::{math::TextMath, properties::PropertyFrame};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextBaseStyle {
    pub fill_color: Option<[f64; 4]>,
    pub stroke_color: Option<[f64; 4]>,
    pub stroke_width: Option<f64>,
    pub opacity: Option<f64>,
    pub code_point: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCharacter {
    pub anchor_point: [f64; 3],
    pub position: [f64; 3],
    pub scale: [f64; 3],
    pub rotation: [f64; 3],
    pub skew: f64,
    pub skew_axis: f64,
    pub opacity: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fill_color: Option<[f64; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stroke_color: Option<[f64; 4]>,
    pub stroke_width: f64,
    pub tracking: f64,
    pub line_anchor: f64,
    pub line_spacing: [f64; 2],
    pub code_point: f64,
    pub blur: [f64; 2],
}

impl TextCharacter {
    pub(super) fn new(base: &TextBaseStyle) -> Self {
        Self {
            anchor_point: [0.0; 3],
            position: [0.0; 3],
            scale: [1.0; 3],
            rotation: [0.0; 3],
            skew: 0.0,
            skew_axis: 0.0,
            opacity: TextMath::bounded(base.opacity.unwrap_or(1.0), 0.0, 1.0, 1.0),
            fill_color: base.fill_color.map(Self::color),
            stroke_color: base.stroke_color.map(Self::color),
            stroke_width: TextMath::bounded(
                base.stroke_width.unwrap_or(0.0),
                f64::NEG_INFINITY,
                f64::INFINITY,
                0.0,
            ),
            tracking: 0.0,
            line_anchor: 50.0,
            line_spacing: [0.0; 2],
            code_point: Self::code_point(base.code_point.unwrap_or(65533.0)),
            blur: [0.0; 2],
        }
    }

    pub(super) fn apply(&mut self, p: &PropertyFrame, raw_amount: f64) {
        let amount = TextMath::bounded(raw_amount, -1.0, 1.0, 0.0);
        Self::add(&mut self.anchor_point, p.anchor_point, amount);
        Self::add(&mut self.position, p.position, amount);
        Self::add(&mut self.rotation, p.rotation, amount);
        if let Some(scale) = p.scale {
            for (out, value) in self.scale.iter_mut().zip(scale) {
                *out *= 1.0
                    + (TextMath::bounded(value, -10000.0, 10000.0, 100.0) / 100.0 - 1.0) * amount;
            }
        }
        self.skew += p.skew.unwrap_or(0.0) * amount;
        self.skew_axis += p.skew_axis.unwrap_or(0.0) * amount;
        self.opacity *= 1.0
            + (TextMath::bounded(p.opacity.unwrap_or(100.0), 0.0, 100.0, 100.0) / 100.0 - 1.0)
                * amount;
        self.stroke_width += p.stroke_width.unwrap_or(0.0) * amount;
        self.tracking += p.tracking.unwrap_or(0.0) * amount;
        if let Some(anchor) = p.line_anchor {
            self.line_anchor += (TextMath::bounded(anchor, 0.0, 100.0, 50.0) - 50.0) * amount;
        }
        Self::add(&mut self.line_spacing, p.line_spacing, amount);
        Self::add(&mut self.blur, p.blur, amount);
        if let Some(offset) = p.character_offset {
            let offset = offset * amount;
            self.code_point = if let Some(range) =
                Self::preserved_range(self.code_point).filter(|_| !p.full_unicode)
            {
                Self::wrap(self.code_point + TextMath::round(offset), range)
            } else {
                Self::code_point(self.code_point + offset)
            };
        }
        if let Some(value) = p.character_value {
            let mut target = Self::code_point(value);
            if let Some(source_range) =
                Self::preserved_range(self.code_point).filter(|_| !p.full_unicode)
            {
                target = match Self::preserved_range(target) {
                    Some(range) if range[1] - range[0] == source_range[1] - source_range[0] => {
                        source_range[0] + target - range[0]
                    }
                    _ => Self::wrap(target, source_range),
                };
            }
            self.code_point =
                Self::code_point(self.code_point + (target - self.code_point) * amount);
        }
        Self::blend(&mut self.fill_color, p.fill_color, amount);
        Self::blend(&mut self.stroke_color, p.stroke_color, amount);
    }

    pub(super) fn finish(&mut self) {
        self.opacity = self.opacity.clamp(0.0, 1.0);
        self.stroke_width = self.stroke_width.max(0.0);
        self.blur = self.blur.map(|v| v.max(0.0));
        self.code_point = Self::code_point(self.code_point);
    }

    fn add<const N: usize>(out: &mut [f64; N], value: Option<[f64; N]>, amount: f64) {
        if let Some(value) = value {
            for (out, value) in out.iter_mut().zip(value) {
                *out += value * amount;
            }
        }
    }

    fn blend(out: &mut Option<[f64; 4]>, target: Option<[f64; 4]>, amount: f64) {
        if let Some(target) = target {
            let mut source = out.unwrap_or(target);
            for (out, target) in source.iter_mut().zip(target) {
                *out += (target - *out) * amount.clamp(0.0, 1.0);
            }
            *out = Some(Self::color(source));
        }
    }

    fn color(value: [f64; 4]) -> [f64; 4] {
        value.map(|v| TextMath::bounded(v, 0.0, 1.0, 0.0))
    }

    fn code_point(value: f64) -> f64 {
        let value = TextMath::round(TextMath::bounded(value, 0.0, 1114111.0, 65533.0));
        if (55296.0..=57343.0).contains(&value) {
            65533.0
        } else {
            value
        }
    }

    fn preserved_range(value: f64) -> Option<[f64; 2]> {
        [[65.0, 90.0], [97.0, 122.0], [48.0, 57.0]]
            .into_iter()
            .find(|r| (r[0]..=r[1]).contains(&value))
    }

    fn wrap(value: f64, range: [f64; 2]) -> f64 {
        let length = range[1] - range[0] + 1.0;
        range[0] + ((TextMath::round(value) - range[0]) % length + length) % length
    }
}

use aster_eval::{TextAnimatorFrame, TextBaseStyle, TextCharacter};
use aster_text::{
    NativeFont, ShapedText, TextAlignment, TextDirection, TextLayoutResult, TextShaper,
};
use serde::Serialize;

use crate::{ProjectRenderError, text_style::ProjectTextStyle, text_units::NativeTextUnits};

#[derive(Clone, Copy, Debug, Serialize)]
pub struct TextAffine(pub [f64; 6]);

impl TextAffine {
    pub fn compose(self, rhs: Self) -> Self {
        let [a, b, c, d, e, f] = self.0;
        let [g, h, i, j, k, l] = rhs.0;
        Self([
            a * g + c * h,
            b * g + d * h,
            a * i + c * j,
            b * i + d * j,
            a * k + c * l + e,
            b * k + d * l + f,
        ])
    }

    pub fn point(self, point: [f64; 2]) -> [f64; 2] {
        let [a, b, c, d, e, f] = self.0;
        let [x, y] = point;
        [a * x + c * y + e, b * x + d * y + f]
    }

    fn rotation(degrees: f64) -> Self {
        let (s, c) = degrees.to_radians().sin_cos();
        Self([c, s, -s, c, 0., 0.])
    }

    fn character(
        state: &TextCharacter,
        origin: [f64; 2],
        width: f64,
        scale: f64,
        line: usize,
    ) -> Self {
        let z = state.position[2] + state.anchor_point[2] * (1. - state.scale[2]);
        let depth = (1. / (1. + z / 1000.)).clamp(0.01, 100.);
        let sx = state.scale[0] * state.rotation[1].to_radians().cos() * depth;
        let sy = state.scale[1] * state.rotation[0].to_radians().cos() * depth;
        let mut result = Self([
            1.,
            0.,
            0.,
            1.,
            origin[0]
                + width / 2.
                + (state.position[0] + state.line_spacing[0] * line as f64) * scale,
            origin[1] + (state.position[1] + state.line_spacing[1] * line as f64) * scale,
        ])
        .compose(Self::rotation(state.rotation[2]));
        if state.skew.abs() > 0.00001 {
            result = result
                .compose(Self::rotation(-state.skew_axis))
                .compose(Self([1., 0., -state.skew.to_radians().tan(), 1., 0., 0.]))
                .compose(Self::rotation(state.skew_axis));
        }
        result
            .compose(Self([sx, 0., 0., sy, 0., 0.]))
            .compose(Self([
                1.,
                0.,
                0.,
                1.,
                -state.anchor_point[0] * scale,
                -state.anchor_point[1] * scale,
            ]))
            .compose(Self([1., 0., 0., 1., -width / 2., 0.]))
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ProjectTextPaint {
    pub text: String,
    pub shaped: ShapedText,
    /// Maps the run's Canvas middle baseline into scaled layer coordinates.
    pub transform: TextAffine,
    pub fill: [f64; 4],
    pub stroke: [f64; 4],
    pub stroke_radius: f64,
    pub blur: f64,
}

pub(crate) struct TextPaintEvaluator;

impl TextPaintEvaluator {
    pub fn evaluate(
        style: &ProjectTextStyle,
        layout: &TextLayoutResult,
        animation: Option<&TextAnimatorFrame>,
        scale: f64,
        locale: &str,
        fonts: &[NativeFont],
        shaper: &TextShaper,
    ) -> Result<Vec<ProjectTextPaint>, ProjectRenderError> {
        let units = NativeTextUnits::segment(
            &layout
                .lines
                .iter()
                .map(|l| l.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        )?;
        let mut unit_index = 0;
        let mut paints = Vec::new();
        for (line_index, line) in layout.lines.iter().enumerate() {
            if line.fragments.is_empty()
                && animation.is_none()
                && (style.tracking * scale).abs() < 0.00001
            {
                paints.push(ProjectTextPaint {
                    text: String::new(),
                    shaped: ShapedText {
                        glyphs: Vec::new(),
                        advance: 0.,
                        middle_baseline_offset: 0.,
                    },
                    transform: TextAffine([1., 0., 0., 1., line.origin[0], line.origin[1]]),
                    fill: Self::css_color(style.fill),
                    stroke: Self::css_color(style.stroke),
                    stroke_radius: style.stroke_width * scale,
                    blur: 0.,
                });
            }
            let mut runs = Vec::new();
            for fragment in &line.fragments {
                let state = if let Some(frame) = animation {
                    let unit = units.get(unit_index).ok_or_else(|| {
                        ProjectRenderError::Invalid("text layout and selector units differ".into())
                    })?;
                    unit_index += 1;
                    if unit.text != fragment.text {
                        return Err(ProjectRenderError::Invalid(
                            "text grapheme identity differs".into(),
                        ));
                    }
                    Some(frame.character(
                        &unit.context,
                        &TextBaseStyle {
                            fill_color: Some(style.fill),
                            stroke_color: Some(style.stroke),
                            stroke_width: Some(style.stroke_width),
                            code_point: Some(unit.code_point),
                            opacity: Some(1.),
                        },
                        true,
                    )?)
                } else {
                    None
                };
                let text = if let Some(state) = &state {
                    if fragment.text.chars().next().map(|ch| u32::from(ch) as f64)
                        == Some(state.code_point)
                    {
                        fragment.text.clone()
                    } else {
                        char::from_u32(state.code_point as u32)
                            .unwrap_or('\u{fffd}')
                            .to_string()
                    }
                } else {
                    fragment.text.clone()
                };
                let shaped = if text == fragment.text {
                    fragment.shaped.clone()
                } else {
                    shaper.shape(
                        &text,
                        style.font_size * scale,
                        TextDirection::LeftToRight,
                        locale,
                        fonts,
                    )?
                };
                runs.push((text, shaped, state, fragment.x));
            }
            let mut left = line.origin[0];
            if animation.is_some() {
                let width = runs.iter().map(|(_, s, _, _)| s.advance).sum::<f64>()
                    + runs.len().saturating_sub(1) as f64 * style.tracking * scale;
                let compensation = runs
                    .iter()
                    .take(runs.len().saturating_sub(1))
                    .filter_map(|r| r.2.as_ref())
                    .map(|s| s.tracking * scale * s.line_anchor / 100.)
                    .sum::<f64>();
                let remaining = style.size[0] * scale * 0.94 - width;
                left = style.size[0] * scale * 0.03
                    + match style.alignment {
                        TextAlignment::Left => 0.,
                        TextAlignment::Center => remaining / 2.,
                        TextAlignment::Right => remaining,
                    }
                    - compensation;
            }
            let mut cursor = 0.;
            for (text, shaped, state, x) in runs {
                let (transform, fill, stroke, radius, blur) = if let Some(s) = &state {
                    let mut fill = s.fill_color.unwrap_or([1.; 4]);
                    let mut stroke = s.stroke_color.unwrap_or([0., 0., 0., 1.]);
                    fill[3] *= s.opacity;
                    stroke[3] *= s.opacity;
                    (
                        TextAffine::character(
                            s,
                            [left + cursor, line.origin[1]],
                            shaped.advance,
                            scale,
                            line_index,
                        ),
                        fill,
                        stroke,
                        s.stroke_width * scale,
                        s.blur[0].max(s.blur[1]) * scale,
                    )
                } else {
                    (
                        TextAffine([1., 0., 0., 1., line.origin[0] + x, line.origin[1]]),
                        style.fill,
                        style.stroke,
                        style.stroke_width * scale,
                        0.,
                    )
                };
                cursor += shaped.advance
                    + style.tracking * scale
                    + state.as_ref().map_or(0., |s| s.tracking * scale);
                if transform
                    .0
                    .iter()
                    .any(|n| !n.is_finite() || n.abs() > 1_048_576.)
                {
                    return Err(ProjectRenderError::Invalid(
                        "text transform exceeds bounds".into(),
                    ));
                }
                paints.push(ProjectTextPaint {
                    text,
                    shaped,
                    transform,
                    fill: Self::css_color(fill),
                    stroke: Self::css_color(stroke),
                    stroke_radius: radius,
                    blur,
                });
            }
        }
        if animation.is_some() && unit_index != units.len() {
            return Err(ProjectRenderError::Invalid(
                "unconsumed selector units".into(),
            ));
        }
        Ok(paints)
    }

    fn css_color(mut color: [f64; 4]) -> [f64; 4] {
        for value in &mut color[..3] {
            *value = (*value * 255.).round() / 255.;
        }
        color
    }
}

use crate::ProjectRenderError;
use aster_text::{FontStyle, TextAlignment, TextDirection, TextLayoutRequest};
use aster_types::editor::Layer;

#[derive(Clone, serde::Serialize)]
pub(crate) struct ProjectTextStyle {
    pub text: String,
    pub families: Vec<String>,
    pub weight: f32,
    pub italic: String,
    pub size: [f64; 2],
    pub font_size: f64,
    pub tracking: f64,
    pub leading: f64,
    pub alignment: TextAlignment,
    pub fill: [f64; 4],
    pub stroke: [f64; 4],
    pub stroke_width: f64,
    pub animated: bool,
}

impl ProjectTextStyle {
    pub fn from_layer(layer: &Layer) -> Result<Self, ProjectRenderError> {
        if layer.kind != "text" {
            return Err(ProjectRenderError::Invalid(
                "native text requires a text layer".into(),
            ));
        }
        let size = Self::numbers(&layer.size)?;
        let hero = layer.name == "ASTER";
        let mut result = Self {
            text: layer
                .text
                .value()
                .cloned()
                .unwrap_or_else(|| layer.name.clone()),
            families: vec!["Inter".into(), "Segoe UI".into(), "sans-serif".into()],
            weight: if hero { 800. } else { 600. },
            italic: "normal".into(),
            size,
            font_size: size[1] * if hero { 0.82 } else { 0.56 },
            tracking: size[1] * if hero { 0.15 } else { 0.34 },
            leading: size[1] * 0.72,
            alignment: TextAlignment::Center,
            fill: Self::numbers(&layer.color)?,
            stroke: [0., 0., 0., 1.],
            stroke_width: 0.,
            animated: layer.text_animator.value().is_some_and(|a| a.enabled),
        };
        if let Some(style) = layer.text_style.value() {
            result.families = Self::families(&style.font_family)?;
            result.weight = Self::number(&style.font_weight)? as f32;
            result.italic = style
                .font_style
                .value()
                .cloned()
                .unwrap_or_else(|| "normal".into());
            result.font_size = Self::number(&style.font_size)?;
            result.tracking = Self::number(&style.tracking)?;
            result.leading = Self::number(&style.leading)?;
            result.alignment = match style.alignment.as_str() {
                "left" => TextAlignment::Left,
                "right" => TextAlignment::Right,
                _ => TextAlignment::Center,
            };
            result.stroke = Self::numbers(&style.stroke_color)?;
            result.stroke_width = Self::number(&style.stroke_width)?;
        }
        if result.text.chars().count() > 4096
            || result.size.iter().any(|n| *n <= 0. || *n > 1_048_576.)
            || !(1.0..=1000.0).contains(&result.weight)
            || result.font_size <= 0.
            || result.stroke_width < 0.
            || result
                .fill
                .iter()
                .chain(&result.stroke)
                .any(|n| !(0.0..=1.0).contains(n))
        {
            return Err(ProjectRenderError::Invalid(
                "native text style bounds".into(),
            ));
        }
        Ok(result)
    }

    pub fn font_style(&self) -> Option<FontStyle> {
        match self.italic.as_str() {
            "normal" => Some(FontStyle::Normal),
            "italic" => Some(FontStyle::Italic),
            "oblique" => Some(FontStyle::Oblique),
            _ => None,
        }
    }

    pub fn layout(&self, locale: &str, scale: f64) -> TextLayoutRequest {
        TextLayoutRequest {
            text: self.text.clone(),
            width: self.size[0] * scale,
            height: self.size[1] * scale,
            font_size: self.font_size * scale,
            tracking: self.tracking * scale,
            leading: self.leading * scale,
            alignment: self.alignment,
            direction: TextDirection::LeftToRight,
            language: locale.into(),
            per_grapheme: self.animated,
        }
    }

    pub fn families(value: &str) -> Result<Vec<String>, ProjectRenderError> {
        if value.len() > 4096 {
            return Err(ProjectRenderError::Invalid(
                "font family list exceeds budget".into(),
            ));
        }
        let mut names = Vec::new();
        let mut current = String::new();
        let mut quote = None;
        for ch in value.chars() {
            if let Some(delimiter) = quote {
                if ch == delimiter {
                    quote = None;
                } else {
                    current.push(ch);
                }
            } else if ch == '\'' || ch == '"' {
                quote = Some(ch);
            } else if ch == ',' {
                names.push(std::mem::take(&mut current));
            } else {
                current.push(ch);
            }
        }
        names.push(current);
        let names = names
            .into_iter()
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>();
        if names.len() > 64 {
            return Err(ProjectRenderError::Invalid(
                "font family count exceeds budget".into(),
            ));
        }
        Ok(if names.is_empty() {
            vec!["sans-serif".into()]
        } else {
            names
        })
    }

    fn number(value: &serde_json::Number) -> Result<f64, ProjectRenderError> {
        value
            .as_f64()
            .filter(|v| v.is_finite())
            .ok_or_else(|| ProjectRenderError::Invalid("nonfinite text style".into()))
    }

    fn numbers<const N: usize>(
        values: &[serde_json::Number; N],
    ) -> Result<[f64; N], ProjectRenderError> {
        let numbers = values
            .iter()
            .map(Self::number)
            .collect::<Result<Vec<_>, _>>()?;
        numbers
            .try_into()
            .map_err(|_| ProjectRenderError::Invalid("text vector size".into()))
    }
}

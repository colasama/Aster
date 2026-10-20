use crate::{EvaluationError, vertex::VertexPaint};
use aster_types::editor::EffectMask;

#[derive(Clone, Debug)]
pub struct EffectMaskInput {
    values: [f64; 8],
    pub path_id: Option<String>,
}
impl EffectMaskInput {
    pub fn compile(mask: &EffectMask) -> Result<Self, EvaluationError> {
        if !["ellipse", "rectangle", "path"].contains(&mask.shape.as_str()) {
            return Err(EvaluationError::InvalidProperty(
                "unknown effect mask shape".into(),
            ));
        }
        let [x, y] = VertexPaint::numbers(&mask.center)?;
        let [w, h] = VertexPaint::numbers(&mask.size)?;
        let [feather, opacity] =
            VertexPaint::numbers(&[mask.feather.clone(), mask.opacity.clone()])?;
        Ok(Self {
            values: [
                x / 100.0,
                y / 100.0,
                w / 100.0,
                h / 100.0,
                feather,
                opacity / 100.0,
                f64::from(mask.invert),
                f64::from(mask.shape == "rectangle"),
            ],
            path_id: mask.path_id.value().cloned(),
        })
    }

    pub fn uniforms(&self, pixel_scale: f64) -> Result<[f32; 8], EvaluationError> {
        let mut values = self.values;
        values[4] *= pixel_scale;
        let packed = values.map(|v| v as f32);
        if !packed.iter().all(|v| v.is_finite()) {
            return Err(EvaluationError::InvalidProperty(
                "nonfinite effect mask uniform".into(),
            ));
        }
        Ok(packed)
    }
}

use crate::{EvaluationError, EvaluationLimits, ScalarTrack};
use aster_types::editor::{Animatable, ShapeGroupTransform};

#[derive(Clone, Debug)]
pub(super) struct GroupTransform {
    properties: [ScalarTrack; 6],
}

impl GroupTransform {
    pub fn compile(
        value: &ShapeGroupTransform,
        limits: &EvaluationLimits,
    ) -> Result<Self, EvaluationError> {
        let inputs = [
            &value.position[0],
            &value.position[1],
            &value.scale[0],
            &value.scale[1],
            &value.rotation,
            &value.opacity,
        ];
        for property in inputs {
            if let Animatable::Animated { keyframes, .. } = property {
                for key in keyframes {
                    if key.id.is_empty() || key.id.encode_utf16().count() > 256 {
                        return Err(EvaluationError::InvalidScene(
                            "invalid shape key identity".into(),
                        ));
                    }
                }
            }
        }
        let mut compiled = Vec::with_capacity(6);
        for property in inputs {
            compiled.push(ScalarTrack::compile_shape_graph(property, limits)?);
        }
        Ok(Self {
            properties: compiled
                .try_into()
                .map_err(|_| EvaluationError::InvalidScene("invalid shape transform".into()))?,
        })
    }

    pub fn evaluate(&self, time: f64) -> Result<([f64; 6], f64), EvaluationError> {
        let mut values = [0.0; 6];
        for (value, track) in values.iter_mut().zip(&self.properties) {
            *value = track.evaluate(time)?;
        }
        let [x, y, sx, sy, rotation, opacity] = values;
        let sx = sx / 100.0;
        let sy = sy / 100.0;
        let radians = (rotation * std::f64::consts::PI) / 180.0;
        Ok((
            [
                radians.cos() * sx,
                radians.sin() * sx,
                -radians.sin() * sy,
                radians.cos() * sy,
                x,
                y,
            ],
            (opacity / 100.0).clamp(0.0, 1.0),
        ))
    }

    pub fn multiply(a: [f64; 6], b: [f64; 6]) -> [f64; 6] {
        [
            a[0] * b[0] + a[2] * b[1],
            a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3],
            a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4],
            a[1] * b[4] + a[3] * b[5] + a[5],
        ]
    }
}

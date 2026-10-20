use crate::EvaluationError;
use aster_types::editor::Layer;
use serde_json::Number;

#[derive(Clone)]
pub(crate) struct VertexPaint {
    pub color: [f64; 4],
    pub material: [f64; 4],
    pub shape_color: [f64; 4],
    pub shape_parameters: [f64; 4],
    pub gradient_color: [f64; 4],
    pub gradient_parameters: [f64; 4],
}

pub(crate) struct SceneVertex {
    pub clip: [f64; 3],
    pub world: [f64; 3],
    pub uv: [f64; 2],
    pub normal: [f64; 3],
    pub tangent: [f64; 4],
    pub media_type: f64,
}

impl VertexPaint {
    pub fn evaluate(layer: &Layer, opacity: f64, size: [f64; 2]) -> Result<Self, EvaluationError> {
        let mesh = layer.mesh.value();
        let shape = layer.shape.value();
        let is_shape = layer.kind == "shape";
        let is_mesh = layer.kind == "mesh";
        let material = layer
            .material
            .value()
            .or_else(|| mesh.and_then(|m| m.source_material.value()));
        let source_color = if layer.kind == "solid" {
            layer.solid.value().map_or(&layer.color, |s| &s.color)
        } else {
            &layer.color
        };
        let mut color = Self::numbers::<4>(source_color)?;
        for channel in &mut color[..3] {
            *channel = if layer.kind == "text" {
                1.0
            } else {
                channel.min(4.0)
            };
        }
        color[3] *= opacity;
        let mut material_values = [
            0.12,
            0.48,
            0.0,
            if is_shape {
                opacity
            } else if layer.three_dimensional || is_mesh {
                1.0
            } else {
                0.0
            },
        ];
        if let Some(m) = material {
            material_values[..3].copy_from_slice(&Self::numbers::<3>(&[
                m.metallic.clone(),
                m.roughness.clone(),
                m.emissive.clone(),
            ])?);
        }
        let inferred = shape.map_or(
            if is_shape && layer.size[0].as_f64() == layer.size[1].as_f64() {
                "ellipse"
            } else {
                "rectangle"
            },
            |s| s.kind.as_str(),
        );
        let minimum = size[0].abs().min(size[1].abs()).max(1.0);
        let shape_color = if is_mesh {
            [
                1.0,
                1.0,
                1.0,
                mesh.and_then(|m| m.base_color.value())
                    .and_then(|c| c[3].as_f64())
                    .unwrap_or(1.0),
            ]
        } else if let Some(shape) = shape {
            Self::numbers::<4>(&shape.stroke_color)?
        } else {
            [1.0; 4]
        };
        let shape_parameters = [
            if is_shape {
                (shape.and_then(|s| s.stroke_width.as_f64()).unwrap_or(0.0) / minimum) * 2.0
            } else {
                0.0
            },
            if is_shape {
                (shape.and_then(|s| s.roundness.as_f64()).unwrap_or(0.0) / minimum).min(0.49)
            } else {
                0.0
            },
            if layer.kind == "solid" && !layer.three_dimensional {
                1.0
            } else if is_shape {
                match inferred {
                    "ellipse" => 2.0,
                    "line" => 3.0,
                    "bezier" => 4.0,
                    _ => 1.0,
                }
            } else {
                0.0
            },
            if shape.is_some_and(|s| s.line_cap == "round") {
                1.0
            } else {
                0.0
            },
        ];
        let gradient_color = if let Some(shape) = shape {
            Self::numbers::<4>(&shape.gradient_color)?
        } else {
            [0.0, 0.0, 0.0, 1.0]
        };
        let gradient_parameters = [
            if is_mesh {
                match material.map(|m| m.alpha_mode.as_str()) {
                    Some("mask") => 1.0,
                    Some("blend") => 2.0,
                    _ => 0.0,
                }
            } else {
                match shape.map(|s| s.fill_mode.as_str()) {
                    Some("linear") => 1.0,
                    Some("radial") => 2.0,
                    _ => 0.0,
                }
            },
            if is_mesh {
                material
                    .and_then(|m| m.alpha_cutoff.as_f64())
                    .unwrap_or(0.5)
            } else {
                shape.and_then(|s| s.gradient_angle.as_f64()).unwrap_or(0.0) * std::f64::consts::PI
                    / 180.0
            },
            if inferred == "rectangle" {
                size[0].abs().max(1.0) / minimum
            } else {
                shape.and_then(|s| s.dash_length.as_f64()).unwrap_or(0.0) / size[0].abs().max(1.0)
            },
            if inferred == "rectangle" {
                size[1].abs().max(1.0) / minimum
            } else {
                shape.and_then(|s| s.dash_gap.as_f64()).unwrap_or(0.0) / size[0].abs().max(1.0)
            },
        ];
        Ok(Self {
            color,
            material: material_values,
            shape_color,
            shape_parameters,
            gradient_color,
            gradient_parameters,
        })
    }

    pub fn vertex(
        &self,
        vertex: SceneVertex,
        size: [f64; 2],
    ) -> Result<[f32; 40], EvaluationError> {
        let mut data = [0.0; 40];
        data[..3].copy_from_slice(&[
            (vertex.clip[0] / size[0]) * 2.0 - 1.0,
            1.0 - (vertex.clip[1] / size[1]) * 2.0,
            vertex.clip[2],
        ]);
        data[3..5].copy_from_slice(&vertex.uv);
        data[5..9].copy_from_slice(&self.color);
        data[9] = vertex.media_type;
        data[10..13].copy_from_slice(&vertex.normal);
        data[13..17].copy_from_slice(&self.material);
        data[17..20].copy_from_slice(&vertex.world);
        data[20..24].copy_from_slice(&self.shape_color);
        data[24..28].copy_from_slice(&self.shape_parameters);
        data[28..32].copy_from_slice(&self.gradient_color);
        data[32..36].copy_from_slice(&self.gradient_parameters);
        data[36..40].copy_from_slice(&vertex.tangent);
        let data = data.map(|v| v as f32);
        if data.iter().any(|v| !v.is_finite()) {
            return Err(EvaluationError::InvalidScene(
                "non-finite scene vertex".into(),
            ));
        }
        Ok(data)
    }

    pub fn numbers<const N: usize>(values: &[Number]) -> Result<[f64; N], EvaluationError> {
        let mut result = [0.0; N];
        if values.len() != N {
            return Err(EvaluationError::InvalidScene(
                "invalid numeric vector length".into(),
            ));
        }
        for (target, source) in result.iter_mut().zip(values) {
            *target = source.as_f64().filter(|v| v.is_finite()).ok_or_else(|| {
                EvaluationError::InvalidScene("non-finite geometry number".into())
            })?;
        }
        Ok(result)
    }
}

use crate::{EvaluatedTransform, EvaluationError, vector::Vector3};
use aster_types::editor::Layer;
use serde_json::Number;

/// Uniform storage for the shared eight-light shader ABI.
#[derive(Clone, Debug)]
pub struct SceneLighting {
    pub data: [f32; 148],
    pub shadow_map_size: u32,
}

impl SceneLighting {
    pub fn evaluate<'a>(
        layers: impl IntoIterator<Item = (&'a Layer, &'a EvaluatedTransform)>,
        size: [f64; 2],
        shadows_available: bool,
        camera_position: Option<[f64; 3]>,
    ) -> Result<Self, EvaluationError> {
        if size.iter().any(|v| !v.is_finite() || *v <= 0.0) {
            return Err(EvaluationError::InvalidScene(
                "invalid lighting dimensions".into(),
            ));
        }
        let lights: Vec<_> = layers
            .into_iter()
            .filter(|(layer, _)| layer.kind == "light")
            .take(8)
            .collect();
        let primary = lights.first();
        let direction = primary
            .map_or(Vector3([0.35, -0.45, 0.82]), |(_, transform)| {
                Vector3([0.0, 0.0, 1.0]).rotate_euler(transform.rotation)
            })
            .unit_or_zero();
        let settings = primary.and_then(|(layer, _)| layer.light.value());
        let quality = settings.map_or("medium", |s| s.shadow_quality.as_str());
        let color = primary.map_or([1.0, 0.96, 0.9], |(layer, _)| {
            std::array::from_fn(|i| layer.color[i].as_f64().unwrap_or(0.0))
        });
        let position = primary.map_or([0.0; 3], |(_, transform)| transform.position);
        let kind = match settings.map_or("directional", |s| s.kind.as_str()) {
            "directional" => 0.0,
            "point" => 1.0,
            _ => 2.0,
        };
        let mut data = [0.0; 148];
        let header = [
            direction.0[0],
            direction.0[1],
            direction.0[2],
            Self::number(settings.map(|s| &s.intensity), 1.25),
            color[0],
            color[1],
            color[2],
            if primary.is_some() { 0.12 } else { 0.16 },
            position[0],
            position[1],
            position[2],
            kind,
            Self::number(settings.map(|s| &s.range), 10_000.0),
            (Self::number(settings.map(|s| &s.cone_angle), 45.0) * std::f64::consts::PI / 360.0)
                .cos(),
            if quality == "off" || !shadows_available {
                0.0
            } else {
                1.0
            },
            0.0,
        ];
        data[..16].copy_from_slice(&header.map(|v| v as f32));
        let up = if direction.0[1].abs() < 0.96 {
            Vector3([0.0, 1.0, 0.0])
        } else {
            Vector3([1.0, 0.0, 0.0])
        };
        let x = up.cross(direction).unit_or_zero().0;
        let y = direction.cross(Vector3(x)).unit_or_zero().0;
        let span = size[0].max(size[1]) * 1.6;
        let shadow = [
            x[0],
            x[1],
            x[2],
            2.0 / span,
            y[0],
            y[1],
            y[2],
            2.0 / span,
            direction.0[0],
            direction.0[1],
            direction.0[2],
            1.0 / (span * 2.0),
            size[0] / 2.0,
            size[1] / 2.0,
            0.0,
            0.0025,
        ];
        data[16..32].copy_from_slice(&shadow.map(|v| v as f32));
        data[32..35].copy_from_slice(
            &camera_position
                .unwrap_or([size[0] / 2.0, size[1] / 2.0, 0.0])
                .map(|v| v as f32),
        );
        data[35] = lights.len().saturating_sub(1) as f32;
        for (index, (layer, transform)) in lights.iter().enumerate().skip(1) {
            let settings = layer.light.value();
            let d = Vector3([0.0, 0.0, 1.0])
                .rotate_euler(transform.rotation)
                .unit_or_zero()
                .0;
            let p = transform.position;
            let c = &layer.color;
            let kind = match settings.map(|s| s.kind.as_str()) {
                Some("point") => 1.0,
                Some("spot") => 2.0,
                _ => 0.0,
            };
            let values = [
                d[0],
                d[1],
                d[2],
                Self::number(settings.map(|s| &s.intensity), 1.25),
                Self::number(Some(&c[0]), 0.0),
                Self::number(Some(&c[1]), 0.0),
                Self::number(Some(&c[2]), 0.0),
                0.0,
                p[0],
                p[1],
                p[2],
                kind,
                Self::number(settings.map(|s| &s.range), 10_000.0),
                (Self::number(settings.map(|s| &s.cone_angle), 45.0) * std::f64::consts::PI
                    / 360.0)
                    .cos(),
                0.0,
                0.0,
            ];
            let offset = 36 + (index - 1) * 16;
            data[offset..offset + 16].copy_from_slice(&values.map(|v| v as f32));
        }
        if data.iter().any(|v| !v.is_finite()) {
            return Err(EvaluationError::InvalidScene(
                "non-finite lighting uniform".into(),
            ));
        }
        Ok(Self {
            data,
            shadow_map_size: match quality {
                "off" => 1,
                "low" => 512,
                "high" => 2048,
                _ => 1024,
            },
        })
    }

    fn number(value: Option<&Number>, fallback: f64) -> f64 {
        value.and_then(Number::as_f64).unwrap_or(fallback)
    }
}

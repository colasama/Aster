use crate::EvaluationError;
use aster_render_ir::{
    ResourceDescriptor, ResourceKind, TextureDimension, TexturePixelFormat,
    TexturePixelsDescriptor, VerifiedResource,
};
use aster_types::editor::Layer;

#[derive(Clone)]
pub struct LutPlan {
    pub resource: VerifiedResource,
    pub label: String,
}

impl LutPlan {
    pub fn prepare(layer: &Layer) -> Result<Self, EvaluationError> {
        let lut = layer
            .effects
            .iter()
            .rev()
            .find(|e| e.enabled && e.effect_type == "lut" && e.resource.value().is_some())
            .and_then(|e| e.resource.value());
        let size = lut
            .map_or(Some(2.0), |r| r.size.as_f64())
            .ok_or_else(|| EvaluationError::InvalidScene("invalid LUT extent".into()))?;
        if !(1.0..=256.0).contains(&size) || size.fract() != 0.0 {
            return Err(EvaluationError::InvalidScene("invalid LUT extent".into()));
        }
        let size = size as u32;
        let count = size as usize * size as usize * size as usize * 3;
        if lut.is_some_and(|r| r.data.len() != count) {
            return Err(EvaluationError::InvalidScene(
                "LUT payload does not match extent".into(),
            ));
        }
        let identity = [
            0., 0., 0., 1., 0., 0., 0., 1., 0., 1., 1., 0., 0., 0., 1., 1., 0., 1., 0., 1., 1., 1.,
            1., 1.,
        ];
        let mut bytes = Vec::with_capacity(count / 3 * 8);
        let values = lut
            .into_iter()
            .flat_map(|r| r.data.iter().map(|n| n.as_f64()))
            .chain(
                identity
                    .iter()
                    .take(if lut.is_none() { identity.len() } else { 0 })
                    .map(|n| Some(*n)),
            );
        for (index, value) in values.enumerate() {
            let value = value
                .ok_or_else(|| EvaluationError::InvalidScene("invalid LUT component".into()))?;
            bytes.extend_from_slice(&Self::half(value).to_le_bytes());
            if index % 3 == 2 {
                bytes.extend_from_slice(&0x3c00_u16.to_le_bytes());
            }
        }
        let resource = VerifiedResource::new(
            ResourceKind::TexturePixels,
            ResourceDescriptor::TexturePixels(TexturePixelsDescriptor {
                dimension: TextureDimension::D3,
                width: size,
                height: size,
                depth: size,
                format: TexturePixelFormat::Rgba16Float,
            }),
            bytes,
        )
        .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        Ok(Self {
            resource,
            label: lut.map_or_else(
                || "Identity 3D LUT".into(),
                |r| format!("3D LUT · {}", r.name),
            ),
        })
    }

    /// Preserve the established upload rounding, including halfway mantissas and subnormals.
    fn half(value: f64) -> u16 {
        if !value.is_finite() {
            return if value > 0.0 {
                0x7bff
            } else if value < 0.0 {
                0xfbff
            } else {
                0x7e00
            };
        }
        let bits = (value.clamp(-65504.0, 65504.0) as f32).to_bits();
        let sign = (bits >> 16) & 0x8000;
        let mut exponent = ((bits >> 23) & 255) as i32 - 112;
        let mut mantissa = bits & 0x7fffff;
        if exponent <= 0 {
            if exponent < -10 {
                return sign as u16;
            }
            mantissa = (mantissa | 0x800000) >> (1 - exponent);
            return (sign | ((mantissa + 0x1000) >> 13)) as u16;
        }
        if exponent >= 31 {
            return (sign | 0x7bff) as u16;
        }
        mantissa += 0x1000;
        if mantissa & 0x800000 != 0 {
            mantissa = 0;
            exponent += 1;
            if exponent >= 31 {
                return (sign | 0x7bff) as u16;
            }
        }
        (sign | ((exponent as u32) << 10) | (mantissa >> 13)) as u16
    }
}

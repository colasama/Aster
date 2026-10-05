use crate::{
    BlobDescriptor, CompositionIdentity, ElementType, FrameHeaderSlice, IrError, ResourceHash,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EffectBlendMode {
    Normal,
    Add,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorBurn,
    ColorDodge,
    SoftLight,
    HardLight,
    Difference,
    Exclusion,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectRoute {
    Layer,
    Adjustment,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LayerEffectSlice {
    pub blob_index: u32,
    pub instance_id: CompositionIdentity,
    pub blend_mode: EffectBlendMode,
    pub route: EffectRoute,
    pub operation_count: u32,
    pub uses_blur: bool,
    pub uses_glow: bool,
    pub lut_hash: ResourceHash,
}

impl LayerEffectSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        self.instance_id.validate()?;
        self.lut_hash.validate()?;
        if self.operation_count > 64
            || !resources.contains(&self.lut_hash)
            || blob.element_type != ElementType::U8
            || blob.byte_length != 4200
            || blob.element_count != 4200
        {
            return Err(IrError::InvalidLayerEffect(
                "layout, count or LUT reference".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn validate_payload(&self, bytes: &[u8], header: &FrameHeaderSlice) -> Result<(), IrError> {
        if bytes.len() != 4200 {
            return Err(IrError::InvalidLayerEffect("payload length".to_owned()));
        }
        let mut uniforms = [0.0_f32; 24];
        for (index, chunk) in bytes[..96].chunks_exact(4).enumerate() {
            uniforms[index] = f32::from_le_bytes(
                chunk
                    .try_into()
                    .map_err(|_| IrError::ElementCountMismatch)?,
            );
        }
        let threshold = f64::from_le_bytes(
            bytes[4192..]
                .try_into()
                .map_err(|_| IrError::ElementCountMismatch)?,
        );
        if uniforms[0] != header.render_target.width as f32
            || uniforms[1] != header.render_target.height as f32
            || uniforms[16] != self.operation_count as f32
            || uniforms[17] != 1.0
            || uniforms[19] != u8::from(self.uses_glow) as f32
            || !uniforms[18].is_finite()
            || uniforms[18].fract() != 0.0
            || !(0.0..=7.0).contains(&uniforms[18])
            || !threshold.is_finite()
            || threshold < 0.0
        {
            return Err(IrError::InvalidLayerEffect(
                "controls differ from metadata or bounds".to_owned(),
            ));
        }
        Ok(())
    }
}

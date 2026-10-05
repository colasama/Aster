use crate::{BlobDescriptor, CompositionIdentity, ElementType, IrError, ResourceHash};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MaterialTextureReference {
    Fallback,
    Texture { hash: ResourceHash },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MaterialBindingSlice {
    pub blob_index: u32,
    pub instance_id: CompositionIdentity,
    pub normal: MaterialTextureReference,
    pub environment: MaterialTextureReference,
}

impl MaterialBindingSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        self.instance_id.validate()?;
        if blob.element_type != ElementType::U8
            || blob.byte_length != 24
            || blob.element_count != 24
        {
            return Err(IrError::InvalidMaterialBinding("scalar layout".to_owned()));
        }
        for reference in [&self.normal, &self.environment] {
            if let MaterialTextureReference::Texture { hash } = reference {
                hash.validate()?;
                if !resources.contains(hash) {
                    return Err(IrError::InvalidMaterialBinding(
                        "undeclared texture".to_owned(),
                    ));
                }
            }
        }
        if matches!(&self.normal, MaterialTextureReference::Texture { .. })
            && self.normal == self.environment
        {
            return Err(IrError::InvalidMaterialBinding(
                "texture roles share a hash".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        if bytes.len() != 24 {
            return Err(IrError::InvalidMaterialBinding(
                "scalar payload length".to_owned(),
            ));
        }
        let mut values = [0.0_f64; 3];
        for (index, chunk) in bytes.chunks_exact(8).enumerate() {
            values[index] = f64::from_le_bytes(
                chunk
                    .try_into()
                    .map_err(|_| IrError::ElementCountMismatch)?,
            );
        }
        if values.iter().any(|v| !v.is_finite())
            || !(-8.0..=8.0).contains(&values[0])
            || !(0.0..=32.0).contains(&values[1])
            || !(0.0..1.0).contains(&values[2])
            || (values[1] != 0.0 && self.environment == MaterialTextureReference::Fallback)
        {
            return Err(IrError::InvalidMaterialBinding(
                "scalar bounds or missing environment".to_owned(),
            ));
        }
        Ok(())
    }
}

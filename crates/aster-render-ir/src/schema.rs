use crate::{FramePlanSliceV1, IrError, PutResource, ResourceMessage, canonical::CanonicalJson};

pub struct FramePlanSchema;

impl FramePlanSchema {
    pub fn emit() -> Result<Vec<u8>, IrError> {
        let mut generator = schemars::SchemaGenerator::default();
        generator.subschema_for::<ResourceMessage>();
        generator.subschema_for::<PutResource>();
        let schema = generator.into_root_schema_for::<FramePlanSliceV1>();
        let canonical = CanonicalJson::encode(&schema)?;
        let ordered: serde_json::Value = serde_json::from_slice(&canonical)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        let mut bytes = serde_json::to_vec_pretty(&ordered)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

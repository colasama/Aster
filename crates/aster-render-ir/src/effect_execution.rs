use crate::{BlobDescriptor, CompositionIdentity, EffectBlendMode, ElementType, IrError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectExecutionRoute {
    Direct,
    Layer,
    Adjustment,
    Skip,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EffectComposite {
    None,
    Fixed,
    Backdrop,
    Replace,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EffectExecutionSlice {
    pub blob_index: u32,
    pub instance_id: CompositionIdentity,
    pub layer_id: CompositionIdentity,
    pub route: EffectExecutionRoute,
    pub blend_mode: EffectBlendMode,
    pub composite: EffectComposite,
}

impl EffectExecutionSlice {
    pub fn validate(&self, blob: &BlobDescriptor) -> Result<(), IrError> {
        self.instance_id.validate()?;
        self.layer_id.validate()?;
        let fixed = matches!(
            self.blend_mode,
            EffectBlendMode::Normal | EffectBlendMode::Add | EffectBlendMode::Screen
        );
        let expected = match self.route {
            EffectExecutionRoute::Layer if fixed => EffectComposite::Fixed,
            EffectExecutionRoute::Layer => EffectComposite::Backdrop,
            EffectExecutionRoute::Adjustment => EffectComposite::Replace,
            _ => EffectComposite::None,
        };
        if self.composite != expected
            || (self.route == EffectExecutionRoute::Direct && !fixed)
            || blob.element_type != ElementType::U32Le
            || blob.byte_length != 16
            || blob.element_count != 4
        {
            return Err(IrError::InvalidEffectExecution(
                "route, composite or fusion layout".to_owned(),
            ));
        }
        Ok(())
    }

    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        if bytes.len() != 16 {
            return Err(IrError::InvalidEffectExecution("fusion bytes".to_owned()));
        }
        let mut counts = [0_u32; 4];
        for (index, chunk) in bytes.chunks_exact(4).enumerate() {
            counts[index] = u32::from_le_bytes(
                chunk
                    .try_into()
                    .map_err(|_| IrError::ElementCountMismatch)?,
            );
        }
        if counts[1] > counts[0] || counts[0] > counts[3] || counts[3] > 64 {
            return Err(IrError::InvalidEffectExecution("fusion counts".to_owned()));
        }
        Ok(())
    }
}

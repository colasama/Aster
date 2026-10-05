use crate::{BlobDescriptor, CompositionIdentity, DecodeLimits, ElementType, Extent2d, IrError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrecompositionTargetRecord {
    pub id: CompositionIdentity,
    pub width: u32,
    pub height: u32,
    pub estimated_bytes: u64,
    pub texture_count: u32,
    pub has_effects: bool,
    pub draw_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrecompositionBinding {
    pub instance_id: CompositionIdentity,
    pub target_index: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrecompositionGraphSlice {
    pub blob_index: u32,
    pub targets: Vec<PrecompositionTargetRecord>,
    pub bindings: Vec<PrecompositionBinding>,
}

impl PrecompositionGraphSlice {
    pub fn validate(&self, blob: &BlobDescriptor, limits: &DecodeLimits) -> Result<(), IrError> {
        if self.targets.len() > 10 || self.bindings.len() > 65_536 {
            return Err(IrError::InvalidPrecomposition(
                "target/binding count".to_owned(),
            ));
        }
        let mut draws = 0_u64;
        let mut textures = 0_u64;
        for (index, target) in self.targets.iter().enumerate() {
            target.id.validate()?;
            if self.targets[..index].iter().any(|t| t.id == target.id) {
                return Err(IrError::InvalidPrecomposition(
                    "duplicate target".to_owned(),
                ));
            }
            Extent2d {
                width: target.width,
                height: target.height,
            }
            .validate(limits)?;
            let expected_bytes = u64::from(target.width)
                * u64::from(target.height)
                * if target.has_effects { 38 } else { 12 };
            if target.estimated_bytes != expected_bytes
                || target.texture_count != if target.has_effects { 5 } else { 2 }
                || target.draw_count > 65_536
            {
                return Err(IrError::InvalidPrecomposition(
                    "cache accounting".to_owned(),
                ));
            }
            draws += u64::from(target.draw_count);
            textures += u64::from(target.texture_count);
        }
        if draws > 65_536 || textures > 20 {
            return Err(IrError::InvalidPrecomposition("surface budget".to_owned()));
        }
        let mut aliases = BTreeMap::new();
        for binding in &self.bindings {
            binding.instance_id.validate()?;
            let units: Vec<u16> = match &binding.instance_id {
                CompositionIdentity::Unicode(text) => text.encode_utf16().collect(),
                CompositionIdentity::Utf16(text) => text.utf16_units.clone(),
            };
            if aliases.insert(units, binding.target_index).is_some()
                || binding.target_index as usize >= self.targets.len()
            {
                return Err(IrError::InvalidPrecomposition("target alias".to_owned()));
            }
        }
        if blob.element_type != ElementType::U32Le
            || u64::from(blob.element_count) != draws + 4
            || u64::from(blob.byte_length) != (draws + 4) * 4
        {
            return Err(IrError::InvalidPrecomposition("routing layout".to_owned()));
        }
        Ok(())
    }

    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        let draws: u64 = self.targets.iter().map(|t| u64::from(t.draw_count)).sum();
        if bytes.len() as u64 != 16 + draws * 4 {
            return Err(IrError::InvalidPrecomposition("routing length".to_owned()));
        }
        let lanes: Vec<u32> = bytes
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        if lanes[0] as usize != self.targets.len()
            || u64::from(lanes[1]) != draws
            || lanes[2] as usize != self.bindings.len()
            || lanes[3] != 0
        {
            return Err(IrError::InvalidPrecomposition("routing header".to_owned()));
        }
        let mut offset = 4;
        for (index, target) in self.targets.iter().enumerate() {
            for route in &lanes[offset..offset + target.draw_count as usize] {
                if *route >= 2 && (*route - 2) as usize >= index {
                    return Err(IrError::InvalidPrecomposition(
                        "child-first routing".to_owned(),
                    ));
                }
            }
            offset += target.draw_count as usize;
        }
        Ok(())
    }
}

use crate::{BlobDescriptor, CompositionIdentity, ElementType, IrError, ResourceHash};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum PrecompositionEffectRecord {
    Direct {
        instance_id: CompositionIdentity,
        execution: ResourceHash,
    },
    Skipped {
        instance_id: CompositionIdentity,
        execution: ResourceHash,
    },
    Failed {
        instance_id: CompositionIdentity,
        execution: ResourceHash,
        error_utf16: Vec<u16>,
    },
    Ready {
        instance_id: CompositionIdentity,
        execution: ResourceHash,
        plan: ResourceHash,
        lut: ResourceHash,
        label_utf16: Vec<u16>,
    },
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrecompositionGeneratorRecord {
    pub instance_id: CompositionIdentity,
    pub plan: ResourceHash,
    pub layer_name_utf16: Vec<u16>,
    pub plugin_id_utf16: Vec<u16>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrecompositionSceneRecord {
    pub target_id: CompositionIdentity,
    pub label_utf16: Vec<u16>,
    pub scene: ResourceHash,
    pub commands: ResourceHash,
    pub draw_count: u32,
    pub effects: Vec<PrecompositionEffectRecord>,
    pub generators: Vec<PrecompositionGeneratorRecord>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PrecompositionBundleSlice {
    pub blob_index: u32,
    pub graph: ResourceHash,
    pub scenes: Vec<PrecompositionSceneRecord>,
}

impl PrecompositionBundleSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        if self.scenes.len() > 10 {
            return Err(IrError::InvalidPrecomposition(
                "bundle scene count".to_owned(),
            ));
        }
        let identity = |id: &CompositionIdentity| -> Result<Vec<u16>, IrError> {
            id.validate()?;
            Ok(match id {
                CompositionIdentity::Unicode(value) => value.encode_utf16().collect(),
                CompositionIdentity::Utf16(value) => value.utf16_units.clone(),
            })
        };
        let mut references = vec![&self.graph];
        let mut targets = BTreeMap::new();
        let mut draws = 0_u64;
        for scene in &self.scenes {
            if targets.insert(identity(&scene.target_id)?, ()).is_some()
                || scene.label_utf16.len() > 65_536
                || scene.draw_count > 65_536
                || scene.effects.len() > 65_536
                || scene.generators.len() > 65_536
            {
                return Err(IrError::InvalidPrecomposition(
                    "bundle scene fields".to_owned(),
                ));
            }
            draws += u64::from(scene.draw_count);
            references.extend([&scene.scene, &scene.commands]);
            let mut effects = BTreeMap::new();
            let mut generators = BTreeMap::new();
            for effect in &scene.effects {
                let (id, execution) = match effect {
                    PrecompositionEffectRecord::Direct {
                        instance_id,
                        execution,
                    }
                    | PrecompositionEffectRecord::Skipped {
                        instance_id,
                        execution,
                    } => (instance_id, execution),
                    PrecompositionEffectRecord::Failed {
                        instance_id,
                        execution,
                        error_utf16,
                    } => {
                        if error_utf16.len() > 65_536 {
                            return Err(IrError::InvalidPrecomposition(
                                "bundle error text".to_owned(),
                            ));
                        }
                        (instance_id, execution)
                    }
                    PrecompositionEffectRecord::Ready {
                        instance_id,
                        execution,
                        plan,
                        lut,
                        label_utf16,
                    } => {
                        if label_utf16.len() > 65_536 {
                            return Err(IrError::InvalidPrecomposition(
                                "bundle LUT text".to_owned(),
                            ));
                        }
                        references.extend([plan, lut]);
                        (instance_id, execution)
                    }
                };
                if effects.insert(identity(id)?, ()).is_some() {
                    return Err(IrError::InvalidPrecomposition(
                        "duplicate bundled effect".to_owned(),
                    ));
                }
                references.push(execution);
            }
            for generator in &scene.generators {
                if generator.layer_name_utf16.len() > 65_536
                    || generator.plugin_id_utf16.len() > 65_536
                {
                    return Err(IrError::InvalidPrecomposition(
                        "bundle generator origin".to_owned(),
                    ));
                }
                if generators
                    .insert(identity(&generator.instance_id)?, ())
                    .is_some()
                {
                    return Err(IrError::InvalidPrecomposition(
                        "duplicate bundled generator".to_owned(),
                    ));
                }
                references.push(&generator.plan);
            }
        }
        for reference in references {
            reference.validate()?;
            if !resources.contains(reference) {
                return Err(IrError::MissingResource(reference.0.clone()));
            }
        }
        if draws > 65_536
            || blob.element_type != ElementType::U32Le
            || u64::from(blob.element_count) != draws + 4
            || u64::from(blob.byte_length) != (draws + 4) * 4
        {
            return Err(IrError::InvalidPrecomposition(
                "bundle draw mapping layout".to_owned(),
            ));
        }
        Ok(())
    }
    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        let counts = [
            self.scenes.len() as u64,
            self.scenes.iter().map(|s| u64::from(s.draw_count)).sum(),
            self.scenes.iter().map(|s| s.effects.len() as u64).sum(),
            self.scenes.iter().map(|s| s.generators.len() as u64).sum(),
        ];
        if bytes.len() as u64 != (counts[1] + 4) * 4 {
            return Err(IrError::InvalidPrecomposition(
                "bundle draw mapping length".to_owned(),
            ));
        }
        for (index, expected) in counts.into_iter().enumerate() {
            let lane = &bytes[index * 4..index * 4 + 4];
            if u64::from(u32::from_le_bytes([lane[0], lane[1], lane[2], lane[3]])) != expected {
                return Err(IrError::InvalidPrecomposition(
                    "bundle count mismatch".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

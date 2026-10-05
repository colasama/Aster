use crate::{
    BlobDescriptor, ElementType, IrError, PrecompositionBundleSlice, PrecompositionEffectRecord,
    PrecompositionGeneratorExecution, PrecompositionGeneratorRecord, ResourceHash,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrameBundleSlice {
    pub blob_index: u32,
    pub scene: ResourceHash,
    pub root: ResourceHash,
    pub post: ResourceHash,
    pub motion: ResourceHash,
    pub output: ResourceHash,
    pub auxiliary: Option<ResourceHash>,
    pub effect: Option<ResourceHash>,
    pub precompositions: Option<ResourceHash>,
    pub shadow_map_size: u32,
    pub effects: Vec<PrecompositionEffectRecord>,
    pub generators: Vec<PrecompositionGeneratorRecord>,
}
impl FrameBundleSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        if self.shadow_map_size == 0
            || self.shadow_map_size > 16_384
            || blob.element_type != ElementType::U32Le
            || blob.element_count != 4
            || blob.byte_length != 16
            || self
                .generators
                .iter()
                .any(|g| !matches!(g.execution, PrecompositionGeneratorExecution::Ready { .. }))
        {
            return Err(IrError::InvalidHeader(
                "frame bundle layout or generator state".to_owned(),
            ));
        }
        let mut references =
            PrecompositionBundleSlice::program_references(&self.effects, &self.generators)?;
        references.extend([
            self.scene.clone(),
            self.root.clone(),
            self.post.clone(),
            self.motion.clone(),
            self.output.clone(),
        ]);
        references.extend(
            [
                self.auxiliary.clone(),
                self.effect.clone(),
                self.precompositions.clone(),
            ]
            .into_iter()
            .flatten(),
        );
        for reference in references {
            reference.validate()?;
            if !resources.contains(&reference) {
                return Err(IrError::MissingResource(reference.0));
            }
        }
        Ok(())
    }
    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        if bytes.len() != 16 {
            return Err(IrError::InvalidHeader(
                "frame bundle payload length".to_owned(),
            ));
        }
        let counts = [
            self.shadow_map_size,
            self.effects.len() as u32,
            self.generators.len() as u32,
            u32::from(self.precompositions.is_some()),
        ];
        for (lane, expected) in bytes.chunks_exact(4).zip(counts) {
            if u32::from_le_bytes([lane[0], lane[1], lane[2], lane[3]]) != expected {
                return Err(IrError::InvalidHeader("frame bundle counts".to_owned()));
            }
        }
        Ok(())
    }
}

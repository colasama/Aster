use crate::generator_program::GeneratorProgram;
use crate::{
    BlobDescriptor, CompositionIdentity, EffectBlendMode, ElementType, IrError, ResourceHash,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SceneGeneratorSlice {
    pub blob_index: u32,
    pub instance_id: CompositionIdentity,
    pub selection_id: CompositionIdentity,
    pub blend_mode: EffectBlendMode,
    pub program: GeneratorProgram,
    pub variant_index: u32,
    pub requested_count: u32,
    pub effective_count: u32,
    pub capacity: u32,
    pub dispatches: Vec<[u32; 3]>,
    pub has_audio: bool,
}
impl SceneGeneratorSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        self.instance_id.validate()?;
        self.selection_id.validate()?;
        self.program.validate(resources)?;
        let g = &self.program.graph;
        let length = if self.has_audio { 11552 } else { 2272 };
        if self.variant_index as usize >= g.render_variants.len()
            || self.requested_count == 0
            || self.requested_count > g.max_instances
            || self.effective_count == 0
            || self.effective_count > self.requested_count
            || self.capacity < self.effective_count
            || self.capacity > g.max_instances
            || (self.has_audio && !self.program.audio_analysis)
            || self.dispatches.len() != g.compute_passes.len()
            || blob.element_type != ElementType::U8
            || blob.byte_length != length
            || blob.element_count != length
        {
            return Err(IrError::InvalidGenerator(
                "invocation bounds or layout".to_owned(),
            ));
        }
        for (dispatch, pass) in self.dispatches.iter().zip(&g.compute_passes) {
            if *dispatch != [self.effective_count.div_ceil(pass.workgroup_size[0]), 1, 1] {
                return Err(IrError::InvalidGenerator("dispatch counts".to_owned()));
            }
        }
        Ok(())
    }
    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        if bytes.len() != if self.has_audio { 11552 } else { 2272 } {
            return Err(IrError::InvalidGenerator("payload length".to_owned()));
        }
        let vertex_count = self
            .program
            .graph
            .render_variants
            .get(self.variant_index as usize)
            .ok_or_else(|| IrError::InvalidGenerator("variant index".to_owned()))?
            .vertex_count;
        for (offset, expected) in [
            (24, self.effective_count),
            (2256, vertex_count),
            (2260, 0),
            (2264, 0),
            (2268, 0),
        ] {
            let actual = u32::from_le_bytes(
                bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| IrError::ElementCountMismatch)?,
            );
            if actual != expected {
                return Err(IrError::InvalidGenerator(
                    "count payload mismatch".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

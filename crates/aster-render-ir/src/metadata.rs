use crate::FinalOutputSlice;
use crate::LayerEffectSlice;
use crate::MotionReconstructionSlice;
use crate::PrecompositionBundleSlice;
use crate::PrecompositionGraphSlice;
use crate::SceneGeneratorSlice;
use crate::{
    CameraParametersSlice, MaterialBindingSlice, TemporalTextPassesSlice, TemporalTextSamplesSlice,
};
use crate::{EffectExecutionSlice, RootSceneCommandsSlice};
use std::collections::BTreeSet;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::{
    CompositionIdentity, DecodeLimits, FrameRate, FrameTime, IrError, ResourceHash,
    SceneBuffersSlice,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanKind {
    FramePlanSlice,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ContractLevel {
    FinalOutputSliceV1,
    MotionReconstructionSliceV1,
    PostUniformsSliceV1,
    SceneBuffersSliceV1,
    CameraParametersSliceV1,
    TemporalTextSamplesSliceV1,
    TemporalTextPassesSliceV1,
    MaterialBindingsSliceV1,
    LayerEffectsSliceV1,
    EffectExecutionSliceV1,
    RootSceneCommandsSliceV1,
    SceneGeneratorSliceV1,
    PrecompositionGraphSliceV1,
    PrecompositionBundleSliceV1,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AntiAliasing {
    Off,
    Fxaa,
    Ssaa2x,
    Ssaa4x,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
pub enum ColorPipeline {
    #[serde(rename = "linear-hdr-to-srgb-display")]
    LinearHdrToSrgbDisplay,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Extent2d {
    #[schemars(range(min = 1))]
    pub width: u32,
    #[schemars(range(min = 1))]
    pub height: u32,
}

impl Extent2d {
    pub fn validate(&self, limits: &DecodeLimits) -> Result<(), IrError> {
        if self.width == 0
            || self.height == 0
            || self.width > limits.max_dimension
            || self.height > limits.max_dimension
            || u64::from(self.width) * u64::from(self.height) > limits.max_pixels
        {
            return Err(IrError::LimitExceeded("target extent".to_owned()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FrameHeaderSlice {
    #[schemars(length(min = 1, max = 256), extend("description" = "Snapshot identity: 1..256 UTF-8 bytes, without NUL."))]
    pub snapshot_scope: String,
    #[schemars(range(max = 9007199254740991_u64))]
    pub project_revision: u64,
    pub composition_id: CompositionIdentity,
    pub time: FrameTime,
    pub frame_rate: FrameRate,
    pub target: Extent2d,
    pub render_target: Extent2d,
    pub aa: AntiAliasing,
    pub color_pipeline: ColorPipeline,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ElementType {
    U8,
    U32Le,
    F32Le,
}

impl ElementType {
    pub fn byte_width(self) -> u32 {
        match self {
            Self::U8 => 1,
            Self::U32Le | Self::F32Le => 4,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BlobDescriptor {
    pub byte_offset: u32,
    #[schemars(range(min = 1))]
    pub byte_length: u32,
    pub element_type: ElementType,
    #[schemars(range(min = 1))]
    pub element_count: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PlanSlice {
    FinalOutput(FinalOutputSlice),
    MotionReconstruction(MotionReconstructionSlice),
    PrecompositionBundle(PrecompositionBundleSlice),
    PrecompositionGraph(PrecompositionGraphSlice),
    SceneGenerator(SceneGeneratorSlice),
    RootSceneCommands(RootSceneCommandsSlice),
    LayerEffect(LayerEffectSlice),
    EffectExecution(EffectExecutionSlice),
    MaterialBinding(MaterialBindingSlice),
    PostProcessUniforms { blob_index: u32 },
    SceneBuffers(SceneBuffersSlice),
    CameraParameters(CameraParametersSlice),
    TemporalTextSamples(TemporalTextSamplesSlice),
    TemporalTextPasses(TemporalTextPassesSlice),
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FramePlanSliceV1 {
    pub kind: PlanKind,
    #[schemars(extend("const" = 1))]
    pub plan_version: u32,
    pub contract_level: ContractLevel,
    #[schemars(extend("const" = false))]
    pub renderer_plan_complete: bool,
    pub header: FrameHeaderSlice,
    #[schemars(length(min = 1))]
    pub blobs: Vec<BlobDescriptor>,
    #[schemars(length(min = 1))]
    pub slices: Vec<PlanSlice>,
    pub resources: Vec<ResourceHash>,
}

impl FramePlanSliceV1 {
    pub fn validate(&self, limits: &DecodeLimits) -> Result<(), IrError> {
        limits.validate()?;
        if self.plan_version != 1 {
            return Err(IrError::InvalidHeader(
                "unsupported plan_version".to_owned(),
            ));
        }
        if self.renderer_plan_complete {
            return Err(IrError::IncompleteFramePlan);
        }
        if self.header.project_revision > 9_007_199_254_740_991 {
            return Err(IrError::InvalidSafeInteger);
        }
        if self.header.snapshot_scope.is_empty()
            || self.header.snapshot_scope.len() > 256
            || self.header.snapshot_scope.contains('\0')
        {
            return Err(IrError::InvalidHeader("invalid snapshot scope".to_owned()));
        }
        self.header.composition_id.validate()?;
        self.header.time.validate()?;
        self.header.frame_rate.validate()?;
        self.header.target.validate(limits)?;
        self.header.render_target.validate(limits)?;
        if self.blobs.is_empty() || self.slices.is_empty() || self.blobs.len() != self.slices.len()
        {
            return Err(IrError::BlobCountMismatch);
        }
        if self.blobs.len() > limits.max_blobs
            || self.slices.len() > limits.max_slices
            || self.resources.len() > limits.max_resource_references
        {
            return Err(IrError::LimitExceeded("metadata array count".to_owned()));
        }
        if self.contract_level == ContractLevel::RootSceneCommandsSliceV1
            && self
                .slices
                .iter()
                .filter(|s| matches!(s, PlanSlice::RootSceneCommands(_)))
                .count()
                != 1
        {
            return Err(IrError::InvalidRootScene("expected one root".to_owned()));
        }
        if self.contract_level == ContractLevel::SceneGeneratorSliceV1 && self.slices.len() != 1 {
            return Err(IrError::InvalidGenerator("expected one slice".to_owned()));
        }
        let mut referenced = BTreeSet::new();
        if matches!(
            self.contract_level,
            ContractLevel::FinalOutputSliceV1 | ContractLevel::MotionReconstructionSliceV1
        ) && (self.slices.len() != 1 || !self.resources.is_empty())
        {
            return Err(IrError::InvalidHeader(
                "expected one transient output route".to_owned(),
            ));
        }
        if self.contract_level == ContractLevel::PrecompositionBundleSliceV1
            && self.slices.len() != 1
        {
            return Err(IrError::InvalidPrecomposition(
                "expected one surface bundle".to_owned(),
            ));
        }
        if self.contract_level == ContractLevel::PrecompositionGraphSliceV1
            && (self.slices.len() != 1 || !self.resources.is_empty())
        {
            return Err(IrError::InvalidPrecomposition(
                "expected one transient graph".to_owned(),
            ));
        }
        for slice in &self.slices {
            let blob_index = match slice {
                PlanSlice::MotionReconstruction(motion)
                    if self.contract_level == ContractLevel::MotionReconstructionSliceV1 =>
                {
                    motion.blob_index
                }
                PlanSlice::FinalOutput(output)
                    if self.contract_level == ContractLevel::FinalOutputSliceV1 =>
                {
                    output.blob_index
                }
                PlanSlice::PrecompositionBundle(bundle)
                    if self.contract_level == ContractLevel::PrecompositionBundleSliceV1 =>
                {
                    bundle.blob_index
                }
                PlanSlice::PrecompositionGraph(graph)
                    if self.contract_level == ContractLevel::PrecompositionGraphSliceV1 =>
                {
                    graph.blob_index
                }
                PlanSlice::SceneGenerator(g)
                    if self.contract_level == ContractLevel::SceneGeneratorSliceV1 =>
                {
                    g.blob_index
                }
                PlanSlice::RootSceneCommands(root)
                    if self.contract_level == ContractLevel::RootSceneCommandsSliceV1 =>
                {
                    root.blob_index
                }
                PlanSlice::EffectExecution(execution)
                    if matches!(
                        self.contract_level,
                        ContractLevel::EffectExecutionSliceV1
                            | ContractLevel::RootSceneCommandsSliceV1
                    ) =>
                {
                    execution.blob_index
                }

                PlanSlice::LayerEffect(effect)
                    if self.contract_level == ContractLevel::LayerEffectsSliceV1 =>
                {
                    effect.blob_index
                }

                PlanSlice::MaterialBinding(material)
                    if matches!(
                        self.contract_level,
                        ContractLevel::MaterialBindingsSliceV1
                            | ContractLevel::RootSceneCommandsSliceV1
                    ) =>
                {
                    material.blob_index
                }
                PlanSlice::PostProcessUniforms { blob_index }
                    if self.contract_level == ContractLevel::PostUniformsSliceV1 =>
                {
                    *blob_index
                }
                PlanSlice::SceneBuffers(scene)
                    if self.contract_level == ContractLevel::SceneBuffersSliceV1 =>
                {
                    scene.blob_index
                }
                PlanSlice::CameraParameters(camera)
                    if self.contract_level == ContractLevel::CameraParametersSliceV1 =>
                {
                    camera.blob_index
                }
                PlanSlice::TemporalTextSamples(temporal)
                    if self.contract_level == ContractLevel::TemporalTextSamplesSliceV1 =>
                {
                    temporal.blob_index
                }
                PlanSlice::TemporalTextPasses(temporal)
                    if self.contract_level == ContractLevel::TemporalTextPassesSliceV1 =>
                {
                    temporal.blob_index
                }
                _ => return Err(IrError::InvalidHeader("slice contract mismatch".to_owned())),
            };
            let blob = self
                .blobs
                .get(blob_index as usize)
                .ok_or(IrError::BlobCountMismatch)?;
            if !referenced.insert(blob_index) {
                return Err(IrError::BlobCountMismatch);
            }
            if let PlanSlice::FinalOutput(output) = slice {
                output.validate(blob)?;
                continue;
            }
            if let PlanSlice::MotionReconstruction(motion) = slice {
                motion.validate(blob)?;
                continue;
            }
            if let PlanSlice::PrecompositionBundle(bundle) = slice {
                bundle.validate(blob, &self.resources)?;
                continue;
            }
            if let PlanSlice::PrecompositionGraph(graph) = slice {
                graph.validate(blob, limits)?;
                continue;
            }
            if let PlanSlice::SceneGenerator(g) = slice {
                g.validate(blob, &self.resources)?;
                continue;
            }
            if let PlanSlice::RootSceneCommands(root) = slice {
                root.validate(blob, &self.slices, &self.resources)?;
                continue;
            }
            if let PlanSlice::EffectExecution(execution) = slice {
                execution.validate(blob)?;
                continue;
            }
            if let PlanSlice::LayerEffect(effect) = slice {
                effect.validate(blob, &self.resources)?;
                continue;
            }
            if let PlanSlice::MaterialBinding(material) = slice {
                material.validate(blob, &self.resources)?;
                continue;
            }
            if let PlanSlice::SceneBuffers(scene) = slice {
                scene.validate(blob, &self.resources)?;
                continue;
            }
            if let PlanSlice::CameraParameters(camera) = slice {
                camera.validate(blob)?;
                continue;
            }
            if let PlanSlice::TemporalTextSamples(temporal) = slice {
                temporal.validate(blob)?;
                continue;
            }
            if let PlanSlice::TemporalTextPasses(temporal) = slice {
                temporal.validate(blob, &self.resources)?;
                continue;
            }
            if blob.element_type != ElementType::F32Le {
                return Err(IrError::BlobTypeMismatch);
            }
            if blob.byte_length != 96 || blob.element_count != 24 {
                return Err(IrError::ElementCountMismatch);
            }
        }
        for blob in &self.blobs {
            if blob.element_count == 0
                || blob
                    .element_count
                    .checked_mul(blob.element_type.byte_width())
                    .ok_or(IrError::ArithmeticOverflow)?
                    != blob.byte_length
            {
                return Err(IrError::ElementCountMismatch);
            }
        }
        for hash in &self.resources {
            hash.validate()?;
        }
        if self.resources.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(IrError::InvalidResource(
                "resource references must be unique and sorted".to_owned(),
            ));
        }
        Ok(())
    }

    pub(crate) fn validate_blob(&self, index: usize, bytes: &[u8]) -> Result<(), IrError> {
        if self.contract_level == ContractLevel::MotionReconstructionSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::MotionReconstruction(motion) = slice
                    && motion.blob_index as usize == index
                {
                    return motion.validate_bytes(bytes, &self.header);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::FinalOutputSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::FinalOutput(output) = slice
                    && output.blob_index as usize == index
                {
                    return output.validate_bytes(bytes);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::PrecompositionBundleSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::PrecompositionBundle(bundle) = slice
                    && bundle.blob_index as usize == index
                {
                    return bundle.validate_payload(bytes);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::PrecompositionGraphSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::PrecompositionGraph(graph) = slice
                    && graph.blob_index as usize == index
                {
                    return graph.validate_payload(bytes);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        let descriptor = self.blobs.get(index).ok_or(IrError::BlobCountMismatch)?;
        if bytes.len() != descriptor.byte_length as usize {
            return Err(IrError::ElementCountMismatch);
        }
        if self.contract_level == ContractLevel::SceneGeneratorSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::SceneGenerator(g) = slice
                    && g.blob_index as usize == index
                {
                    g.validate_payload(bytes)?;
                }
            }
        }
        if self.contract_level == ContractLevel::RootSceneCommandsSliceV1 {
            for slice in &self.slices {
                match slice {
                    PlanSlice::RootSceneCommands(root) if root.blob_index as usize == index => {
                        return root.validate_payload(bytes);
                    }
                    PlanSlice::EffectExecution(effect) if effect.blob_index as usize == index => {
                        return effect.validate_payload(bytes);
                    }
                    PlanSlice::MaterialBinding(material)
                        if material.blob_index as usize == index =>
                    {
                        return material.validate_payload(bytes);
                    }
                    _ => {}
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::EffectExecutionSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::EffectExecution(execution) = slice
                    && execution.blob_index as usize == index
                {
                    return execution.validate_payload(bytes);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::LayerEffectsSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::LayerEffect(effect) = slice
                    && effect.blob_index as usize == index
                {
                    return effect.validate_payload(bytes, &self.header);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::MaterialBindingsSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::MaterialBinding(material) = slice
                    && material.blob_index as usize == index
                {
                    return material.validate_payload(bytes);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::TemporalTextSamplesSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::TemporalTextSamples(temporal) = slice
                    && temporal.blob_index as usize == index
                {
                    return temporal.validate_payload(bytes, &self.header);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level == ContractLevel::TemporalTextPassesSliceV1 {
            for slice in &self.slices {
                if let PlanSlice::TemporalTextPasses(temporal) = slice
                    && temporal.blob_index as usize == index
                {
                    return temporal.validate_payload(bytes);
                }
            }
            return Err(IrError::BlobCountMismatch);
        }
        if self.contract_level != ContractLevel::PostUniformsSliceV1 {
            return Ok(());
        }
        if bytes.len() != 96 {
            return Err(IrError::ElementCountMismatch);
        }
        let mut lanes = [0.0_f32; 24];
        for (index, chunk) in bytes.chunks_exact(4).enumerate() {
            lanes[index] = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        }
        let time_bits = (self.header.time.to_f64()? as f32).to_bits();
        if lanes.iter().enumerate().any(|(index, value)| {
            !value.is_finite() && (index != 2 || value.is_nan() || value.to_bits() != time_bits)
        }) {
            return Err(IrError::InvalidPostUniforms("nonfinite lane".to_owned()));
        }
        if lanes[0] != self.header.render_target.width as f32
            || lanes[1] != self.header.render_target.height as f32
        {
            return Err(IrError::InvalidPostUniforms(
                "render dimensions differ from metadata".to_owned(),
            ));
        }
        if lanes[16].fract() != 0.0
            || !(0.0..=64.0).contains(&lanes[16])
            || ![0.0, 1.0].contains(&lanes[17])
            || ![0.0, 1.0].contains(&lanes[19])
            || lanes[23].to_bits() != 0
        {
            return Err(IrError::InvalidPostUniforms(
                "operation count, flags or reserved lane".to_owned(),
            ));
        }
        Ok(())
    }
}

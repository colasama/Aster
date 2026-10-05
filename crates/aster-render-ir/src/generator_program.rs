use crate::{CompositionIdentity, IrError, ResourceHash};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorPhase {
    Simulation,
    PreRender,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorBlend {
    Normal,
    Add,
    Multiply,
    Screen,
    Overlay,
    Layer,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorDepth {
    None,
    Read,
    ReadWrite,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GeneratorCull {
    None,
    Front,
    Back,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GeneratorCompute {
    pub id: String,
    pub shader: ResourceHash,
    pub entry_point: String,
    pub workgroup_size: [u32; 3],
    pub phase: GeneratorPhase,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GeneratorAuxiliary {
    pub shader: ResourceHash,
    pub vertex_entry: String,
    pub fragment_entry: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GeneratorVariant {
    pub id: String,
    pub shader: ResourceHash,
    pub vertex_entry: String,
    pub fragment_entry: String,
    pub vertex_count: u32,
    pub blend: GeneratorBlend,
    pub depth: GeneratorDepth,
    pub cull: GeneratorCull,
    #[serde(deserialize_with = "Option::deserialize")]
    pub auxiliary: Option<GeneratorAuxiliary>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GeneratorGraph {
    pub api_version: u32,
    pub max_instances: u32,
    pub instance_stride: u32,
    pub compute_passes: Vec<GeneratorCompute>,
    pub render_variants: Vec<GeneratorVariant>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GeneratorProgram {
    pub source_key: CompositionIdentity,
    pub label: CompositionIdentity,
    pub audio_analysis: bool,
    pub graph: GeneratorGraph,
}
impl GeneratorProgram {
    pub fn validate(&self, resources: &[ResourceHash]) -> Result<(), IrError> {
        self.source_key.validate()?;
        self.label.validate()?;
        let g = &self.graph;
        if g.api_version != 1
            || g.max_instances == 0
            || g.max_instances > 1_000_000
            || !(16..=256).contains(&g.instance_stride)
            || !g.instance_stride.is_multiple_of(16)
            || g.compute_passes.is_empty()
            || g.compute_passes.len() > 8
            || g.render_variants.is_empty()
            || g.render_variants.len() > 8
        {
            return Err(IrError::InvalidGenerator("executable bounds".to_owned()));
        }
        let mut ids = BTreeSet::new();
        let mut shaders = BTreeSet::new();
        for pass in &g.compute_passes {
            if !Self::identifier(&pass.id)
                || !Self::identifier(&pass.entry_point)
                || !ids.insert(&pass.id)
                || pass.workgroup_size.iter().any(|n| !(1..=256).contains(n))
                || pass
                    .workgroup_size
                    .iter()
                    .map(|n| u64::from(*n))
                    .product::<u64>()
                    > 256
            {
                return Err(IrError::InvalidGenerator("compute descriptor".to_owned()));
            }
            pass.shader.validate()?;
            shaders.insert(&pass.shader);
        }
        for v in &g.render_variants {
            if !Self::identifier(&v.id)
                || !Self::identifier(&v.vertex_entry)
                || !Self::identifier(&v.fragment_entry)
                || !ids.insert(&v.id)
                || !(1..=65_535).contains(&v.vertex_count)
            {
                return Err(IrError::InvalidGenerator("render descriptor".to_owned()));
            }
            v.shader.validate()?;
            shaders.insert(&v.shader);
            if let Some(a) = &v.auxiliary {
                if !Self::identifier(&a.vertex_entry) || !Self::identifier(&a.fragment_entry) {
                    return Err(IrError::InvalidGenerator("auxiliary descriptor".to_owned()));
                }
                a.shader.validate()?;
                shaders.insert(&a.shader);
            }
        }
        if shaders.len() != resources.len() || shaders.iter().any(|h| !resources.contains(h)) {
            return Err(IrError::InvalidGenerator(
                "shader resource references".to_owned(),
            ));
        }
        Ok(())
    }
    fn identifier(value: &str) -> bool {
        let mut bytes = value.bytes();
        matches!(bytes.next(),Some(b) if b.is_ascii_alphabetic() || b==b'_')
            && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
    }
}

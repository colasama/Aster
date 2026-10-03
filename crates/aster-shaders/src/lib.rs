//! Shared, manifest-assembled WGSL with validated entry points and pipeline constants.

mod catalog;
mod embedded;
mod types;
mod validation;

pub use catalog::{ShaderCatalog, ShaderProgram};
pub use types::{
    EntryPoint, OverrideDefinition, OverrideType, ProgramDefinition, ShaderError, ShaderManifest,
    ShaderStage,
};

#[cfg(test)]
mod tests;

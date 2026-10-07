//! Shared, manifest-assembled WGSL with validated entry points and pipeline constants.

mod catalog;
mod embedded;
mod embedded_post_process;
mod embedded_runtime;
mod types;
mod validation;

pub use catalog::{ShaderCatalog, ShaderProgram};
pub use types::{
    EntryPoint, OverrideDefinition, OverrideType, ProgramDefinition, ProgramFragment, ShaderError,
    ShaderManifest, ShaderStage,
};

#[cfg(test)]
mod constant_tests;
#[cfg(test)]
mod coverage_tests;
mod generator;
mod generator_arithmetic;
#[cfg(test)]
mod generator_tests;
#[cfg(test)]
mod motion_tests;
#[cfg(test)]
mod post_process_tests;
#[cfg(test)]
mod runtime_shader_tests;
#[cfg(test)]
mod tests;
pub use generator::GeneratorShader;

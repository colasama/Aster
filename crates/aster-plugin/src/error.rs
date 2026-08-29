use std::path::PathBuf;

use thiserror::Error;

use crate::generator;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("plugin manifest I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("plugin manifest is invalid TOML: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("plugin manifest is {0} bytes; the v1 limit is 1048576 bytes")]
    ManifestTooLarge(u64),
    #[error("plugin id `{0}` must be a reverse-domain identifier")]
    InvalidId(String),
    #[error("plugin name `{0}` must be non-empty, printable, and at most 256 bytes")]
    InvalidName(String),
    #[error("plugin id `{0}` uses the host-reserved org.aster.builtin namespace")]
    ReservedId(String),
    #[error("plugin id `{0}` is installed more than once")]
    DuplicatePluginId(String),
    #[error("plugin API version {0} is not supported")]
    UnsupportedApi(u32),
    #[error("plugin version `{0}` must use major.minor.patch numeric form")]
    InvalidVersion(String),
    #[error("plugin shader path `{0}` must be a relative .wgsl path")]
    InvalidShaderPath(String),
    #[error("plugin shader was not found at {0}")]
    MissingShader(PathBuf),
    #[error("plugin shader is {0} bytes; the v1 limit is 4194304 bytes")]
    ShaderTooLarge(u64),
    #[error("plugin shaders total {0} bytes; the v1 package limit is 16777216 bytes")]
    ShaderPackageTooLarge(u64),
    #[error("plugin shader resolves outside its plugin directory: {0}")]
    ShaderOutsidePlugin(PathBuf),
    #[error("runtime package contains undeclared shader source `{0}`")]
    UndeclaredShaderSource(String),
    #[error("plugin shader WGSL could not be parsed: {0}")]
    ShaderParse(String),
    #[error("plugin shader WGSL failed validation: {0}")]
    ShaderValidation(String),
    #[error("plugin shader does not implement Aster effect ABI v1: {0}")]
    ShaderAbi(String),
    #[error("plugin shader does not implement Aster scene-generator ABI v1: {0}")]
    GeneratorShaderAbi(String),
    #[error("parameter `{0}` is invalid")]
    InvalidParameter(String),
    #[error("parameter `{0}` is declared more than once")]
    DuplicateParameter(String),
    #[error("plugin declares {actual} parameters; its ABI supports at most {limit}")]
    TooManyParameters { actual: usize, limit: usize },
    #[error(transparent)]
    SceneGenerator(#[from] generator::SceneGeneratorError),
    #[error("effect plugins cannot declare a scene_generator graph")]
    UnexpectedSceneGenerator,
    #[error("scene-generator plugins must declare a scene_generator graph")]
    MissingSceneGenerator,
    #[error("scene-generator plugins require gpu_compute and gpu_render capabilities")]
    MissingGeneratorCapabilities,
    #[error("scene-generator capacity parameter `{0}` is not declared")]
    MissingCapacityParameter(String),
    #[error("scene-generator render parameter `{0}` is not declared")]
    MissingRenderParameter(String),
    #[error(
        "scene-generator parameter `{parameter}` must use type `{expected}` for its declared role"
    )]
    InvalidGeneratorParameterRole {
        parameter: String,
        expected: &'static str,
    },
    #[error("scene-generator selectors must be values of render choice parameter `{0}`")]
    InvalidRenderSelectorChoice(String),
    #[error("plugin.shader `{0}` must be one of the scene-generator graph shaders")]
    PrimaryShaderNotDeclared(String),
    #[error("parameter type `{0}` is not supported by this plugin kind in ABI v1")]
    UnsupportedParameterForKind(&'static str),
}

//! Native, GPU-resident execution of supplied frame plans.
mod adapter_identity;
mod auxiliary_bindings;
mod auxiliary_pipelines;
mod auxiliary_primary;
mod decoded_texture;
mod depth_auxiliary;
mod depth_output;
mod device;
mod effect_region;
mod fixed_composite;
mod frame;
mod frame_depth;
mod frame_motion;
mod frame_plans;
#[cfg(test)]
mod frame_plans_tests;
mod frame_surface;
#[cfg(test)]
mod frame_surface_tests;
mod frame_visualizer;
mod generator_auxiliary;
mod generator_bindings;
mod generator_input;
#[cfg(test)]
mod generator_input_tests;
mod generator_program;
mod generators;
mod geometry_pipelines;
mod gpu_profile;
mod image_cache;
mod image_input;
mod layer_cache;
mod layer_key;
mod layer_plan;
mod layer_targets;
mod layers;
mod lut_cache;
mod material;
mod material_input;
mod motion_output;
mod motion_reconstruction;
mod nv12;
#[cfg(windows)]
mod shared_nv12;
#[cfg(windows)]
pub use shared_nv12::SharedNv12Frame;
mod output;
mod program_time;
mod pyramid;
mod pyramid_levels;
mod region_program;
mod scene;
mod scene_input;
mod shadow;
mod surface_cache;
mod surface_generation;
mod surface_output;
mod surface_plan;
mod surface_post;
mod temporal_cache;
mod temporal_frame;
mod temporal_plan;
mod temporal_text;
mod visualizer;

pub use auxiliary_pipelines::AuxiliaryPrimaryPipelines;
pub use auxiliary_primary::{AuxiliaryPrimaryPlan, AuxiliaryPrimaryTargets};
pub use decoded_texture::DecodedTexturePixels;
pub use depth_output::DepthStatistics;
pub use device::{
    NativeOptions, NativeRenderer, ProjectDeviceLimits, ProjectOutputAvailability,
    ProjectOutputRequest, ProjectSurfaceTarget, RenderedFrame,
};
pub use effect_region::EffectRegionStatistics;
pub use frame::SuppliedFrame;
pub use generator_auxiliary::AuxiliaryGeneratorDraw;
pub use gpu_profile::{GpuTimings, SceneGpuTiming};
pub use image_cache::ImageCacheStatistics;
pub use layer_cache::LayerCacheStatistics;
pub use lut_cache::LutCacheStatistics;
pub use motion_output::MotionStatistics;
pub use surface_cache::SurfaceCacheStatistics;
pub use surface_post::{SurfacePostPipeline, SurfacePostPlan};
pub use temporal_cache::TemporalCacheStatistics;
pub use temporal_plan::TemporalTextPlan;
pub use temporal_text::{TemporalTextPass, TemporalTextPipeline};

#[derive(Debug, thiserror::Error)]
pub enum RenderError {
    #[error(transparent)]
    Plan(#[from] aster_render_ir::IrError),
    #[error(transparent)]
    Shader(#[from] aster_shaders::ShaderError),
    #[error("unsupported native feature: {0}")]
    Unsupported(String),
    #[error("native GPU failure: {0}")]
    Gpu(String),
    #[error("invalid supplied frame: {0}")]
    Invalid(String),
}

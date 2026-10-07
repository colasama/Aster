//! Native, GPU-resident execution of supplied frame plans.
mod device;
mod fixed_composite;
mod frame;
mod geometry_pipelines;
mod image_cache;
mod image_input;
mod layer_plan;
mod layers;
mod lut_cache;
mod output;
mod pyramid;
mod pyramid_levels;
mod scene;
mod scene_input;
mod surface_cache;
mod surface_plan;
mod surface_post;

pub use device::{NativeOptions, NativeRenderer, RenderedFrame};
pub use frame::SuppliedFrame;
pub use image_cache::ImageCacheStatistics;
pub use lut_cache::LutCacheStatistics;
pub use surface_cache::SurfaceCacheStatistics;
pub use surface_post::{SurfacePostPipeline, SurfacePostPlan};

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

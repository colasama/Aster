//! Bounded frame-plan transport. Individual slices are not a complete renderer plan.
mod final_output;
mod motion_reconstruction;
mod post_effect;
pub use motion_reconstruction::{MotionReconstructionSlice, MotionReconstructionStatus};
pub use post_effect::{
    DepthEffectMode, PostEffect, PostEffectInput, PostEffectSlice, PostEffectStatus,
    SurfaceEffectMode,
};
mod generator;
pub use final_output::{FinalBeautySource, FinalOutputRoute, FinalOutputSlice, FinalSurfaceMode};
mod precomposition;
mod precomposition_bundle;
pub use precomposition::{
    PrecompositionBinding, PrecompositionGraphSlice, PrecompositionTargetRecord,
};
pub use precomposition_bundle::{
    PrecompositionBundleSlice, PrecompositionEffectRecord, PrecompositionGeneratorRecord,
    PrecompositionMediaPixels, PrecompositionSceneRecord,
};
mod generator_program;
pub use generator::SceneGeneratorSlice;
pub use generator_program::{
    GeneratorAuxiliary, GeneratorBlend, GeneratorCompute, GeneratorCull, GeneratorDepth,
    GeneratorGraph, GeneratorPhase, GeneratorProgram, GeneratorVariant,
};
mod layer_effect;
pub use layer_effect::{EffectBlendMode, EffectRoute, LayerEffectSlice};

mod camera;
mod canonical;
mod codec;
mod effect_execution;
mod encoded_texture;
mod error;
mod fixture;
mod frame_rate;
mod identity;
mod material;
mod media;
mod metadata;
mod raster;
mod resource;
mod resource_descriptor;
mod root_scene;
mod scene;
mod schema;
mod temporal_pass;
mod temporal_text;
mod texture_pixels;
mod time;
mod wire;

pub use camera::{CameraIrisShape, CameraParametersSlice, CameraPoseMode, CameraProjectionKind};
pub use codec::{DecodeLimits, FplnCodec, OwnedFpln};
pub use effect_execution::{EffectComposite, EffectExecutionRoute, EffectExecutionSlice};
pub use encoded_texture::{EncodedTextureDescriptor, TextureColorConversion, TextureEncoding};
pub use error::IrError;
pub use fixture::IrFixture;
pub use frame_rate::{BinaryRationalTime, FrameRate};
pub use identity::{CompositionIdentity, Utf16CompositionIdentity};
pub use material::{MaterialBindingSlice, MaterialTextureReference};
pub use media::{
    MediaFrameDescriptor, MediaKind, MediaSample, MediaSourceDescriptor, MediaTextureFormat,
};
pub use metadata::{
    AntiAliasing, BlobDescriptor, ColorPipeline, ContractLevel, ElementType, Extent2d,
    FrameHeaderSlice, FramePlanSliceV1, PlanKind, PlanSlice,
};
pub use raster::{RasterOrigin, RasterPixelsDescriptor, RasterSample};
pub use resource::{
    BufferResourceDescriptor, PutOutcome, PutResource, ResourceHash, ResourceKind, ResourceLease,
    ResourceLimits, ResourceMessage, ResourceRegistry, ResourceStatistics,
};
pub use resource_descriptor::ResourceDescriptor;
pub use root_scene::{
    RootCommandRecord, RootDrawRecord, RootLoadOp, RootPassGroup, RootSceneCommandsSlice,
    RootStoreOp, RootTextureReference,
};
pub use scene::{MediaDrawBinding, SceneBuffersSlice, SceneDrawRecord, SceneMediaBinding};
pub use schema::FramePlanSchema;
pub use temporal_pass::TemporalTextPassesSlice;
pub use temporal_text::{TemporalTextFormat, TemporalTextSamplesSlice};
pub use texture_pixels::{TextureDimension, TexturePixelFormat, TexturePixelsDescriptor};
pub use time::{FrameTime, RationalFrameRate, RationalTime};

mod frame_bundle;
pub use frame_bundle::FrameBundleSlice;
mod bundle_dependencies;
pub use bundle_dependencies::BundleDependencies;
pub use precomposition_bundle::PrecompositionGeneratorExecution;
mod auxiliary;
#[cfg(test)]
mod tests;
pub use auxiliary::{AuxiliaryDraw, AuxiliarySlice, AuxiliaryStatus};

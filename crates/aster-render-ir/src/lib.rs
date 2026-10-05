//! Bounded frame-plan transport. The initial uniform slice is not a complete renderer plan.

mod camera;
mod canonical;
mod codec;
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
mod scene;
mod schema;
mod temporal_pass;
mod temporal_text;
mod texture_pixels;
mod time;
mod wire;

pub use camera::{CameraIrisShape, CameraParametersSlice, CameraPoseMode, CameraProjectionKind};
pub use codec::{DecodeLimits, FplnCodec, OwnedFpln};
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
pub use scene::{MediaDrawBinding, SceneBuffersSlice, SceneDrawRecord, SceneMediaBinding};
pub use schema::FramePlanSchema;
pub use temporal_pass::TemporalTextPassesSlice;
pub use temporal_text::{TemporalTextFormat, TemporalTextSamplesSlice};
pub use texture_pixels::{TextureDimension, TexturePixelFormat, TexturePixelsDescriptor};
pub use time::{FrameTime, RationalFrameRate, RationalTime};

#[cfg(test)]
mod tests;

//! Bounded frame-plan transport. The initial uniform slice is not a complete renderer plan.

mod canonical;
mod codec;
mod error;
mod fixture;
mod frame_rate;
mod identity;
mod metadata;
mod resource;
mod schema;
mod time;
mod wire;

pub use codec::{DecodeLimits, FplnCodec, OwnedFpln};
pub use error::IrError;
pub use fixture::IrFixture;
pub use frame_rate::{BinaryRationalTime, FrameRate};
pub use identity::{CompositionIdentity, Utf16CompositionIdentity};
pub use metadata::{
    AntiAliasing, BlobDescriptor, ColorPipeline, ContractLevel, ElementType, Extent2d,
    FrameHeaderSlice, FramePlanSliceV1, PlanKind, PlanSlice,
};
pub use resource::{
    BufferResourceDescriptor, PutOutcome, PutResource, ResourceHash, ResourceKind, ResourceLease,
    ResourceLimits, ResourceMessage, ResourceRegistry, ResourceStatistics,
};
pub use schema::FramePlanSchema;
pub use time::{FrameTime, RationalFrameRate, RationalTime};

#[cfg(test)]
mod tests;

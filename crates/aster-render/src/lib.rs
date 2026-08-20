//! GPU-first render graph and adapter policy.

mod gpu;
mod graph;
mod resource_wrappers;
mod resources;

pub use gpu::{AdapterDiagnostics, preferred_backends};
pub use graph::{
    CompiledGraph, Pass, PassId, PassKind, RenderGraph, RenderGraphError, ResourceDescriptor,
    ResourceHandle, TextureFormat, TransientAllocation,
};
pub use resource_wrappers::{
    BufferResource, BufferResourceDescriptor, TextureResource, TextureResourceDescriptor,
};
pub use resources::{
    GpuObjectCache, ObjectCacheStatistics, PooledResourceId, ResourcePool, ResourcePoolStatistics,
    ResourceSnapshot,
};

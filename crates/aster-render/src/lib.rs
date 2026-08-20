//! GPU-first render graph and adapter policy.

mod gpu;
mod graph;
mod resource_wrappers;
mod resources;

pub use gpu::{
    AdapterDiagnostics, BackendSmokeError, BackendSmokeReport, NativeBackend, preferred_backends,
    smoke_test_backend,
};
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

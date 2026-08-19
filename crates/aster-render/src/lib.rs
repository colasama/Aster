//! GPU-first render graph and adapter policy.

mod gpu;
mod graph;

pub use gpu::{AdapterDiagnostics, preferred_backends};
pub use graph::{
    CompiledGraph, Pass, PassId, PassKind, RenderGraph, RenderGraphError, ResourceDescriptor,
    ResourceHandle, TextureFormat, TransientAllocation,
};

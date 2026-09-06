//! Project model, dependency tracking, and deterministic editing operations.

mod cache;
mod dependency;
mod operation;

pub use aster_types::{
    BlendMode, Composition, Effect, GeneratorParameterValue, Layer, LayerKind, Project,
    PropertyKey, Transform, TransformSnapshot,
};
pub use cache::{CacheStatistics, EvaluationCache, EvaluationCacheKey, EvaluationResolution};
pub use dependency::{DependencyError, DependencyGraph, EvaluationStats, NodeId};
pub use operation::{Operation, OperationError, OperationHistory};

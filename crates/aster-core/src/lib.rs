//! Project model, dependency tracking, and deterministic editing operations.

mod cache;
mod dependency;
mod model;
mod operation;

pub use cache::{CacheStatistics, EvaluationCache, EvaluationCacheKey, EvaluationResolution};
pub use dependency::{DependencyError, DependencyGraph, EvaluationStats, NodeId};
pub use model::{
    BlendMode, Composition, Effect, GeneratorParameterValue, Layer, LayerKind, Project, Transform,
    TransformSnapshot,
};
pub use operation::{Operation, OperationError, OperationHistory, PropertyKey};

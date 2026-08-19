//! Project model, dependency tracking, and deterministic editing operations.

mod dependency;
mod model;
mod operation;

pub use dependency::{DependencyError, DependencyGraph, EvaluationStats, NodeId};
pub use model::{
    BlendMode, Composition, Effect, Layer, LayerKind, Project, Transform, TransformSnapshot,
};
pub use operation::{Operation, OperationError, OperationHistory, PropertyKey};

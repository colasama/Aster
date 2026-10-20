mod compile;
mod transform;

use crate::{EvaluatedPath, EvaluationError};
use serde::{Serialize, Serializer};
use std::{collections::BTreeMap, sync::Arc};
use transform::GroupTransform;

#[derive(Clone, Debug, clap::Args)]
pub struct ShapeGraphLimits {
    #[arg(long,default_value_t=Self::default().max_shape_groups)]
    pub max_shape_groups: usize,
    #[arg(long,default_value_t=Self::default().max_shape_children)]
    pub max_shape_children: usize,
    #[arg(long,default_value_t=Self::default().max_shape_instances)]
    pub max_shape_instances: usize,
    #[arg(long,default_value_t=Self::default().max_shape_paths)]
    pub max_shape_paths: usize,
    #[arg(long,default_value_t=Self::default().max_shape_vertices)]
    pub max_shape_vertices: usize,
    #[arg(long,default_value_t=Self::default().max_shape_depth)]
    pub max_shape_depth: usize,
    #[arg(long,default_value_t=Self::default().max_shape_walk_operations)]
    pub max_shape_walk_operations: usize,
}

impl Default for ShapeGraphLimits {
    fn default() -> Self {
        Self {
            max_shape_groups: 512,
            max_shape_children: 1024,
            max_shape_instances: 4096,
            max_shape_paths: 1024,
            max_shape_vertices: 65_536,
            max_shape_depth: 64,
            max_shape_walk_operations: 1_000_000,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FlattenedShapePath {
    pub instance_id: String,
    pub path_id: String,
    #[serde(serialize_with = "ShapeGraphTrack::serialize_path")]
    pub path: Arc<EvaluatedPath>,
    pub matrix: [f64; 6],
    pub opacity: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedMaskPath {
    pub effect_id: String,
    pub path_id: String,
    #[serde(serialize_with = "ShapeGraphTrack::serialize_path")]
    pub path: Arc<EvaluatedPath>,
    pub opacity: f64,
    pub feather: f64,
    pub invert: bool,
}

#[derive(Clone, Debug)]
pub struct ShapeGraphTrack {
    paths: BTreeMap<String, Arc<EvaluatedPath>>,
    groups: Vec<Group>,
    roots: Vec<usize>,
    limits: ShapeGraphLimits,
}

#[derive(Clone, Debug)]
struct Group {
    visible: bool,
    transform: GroupTransform,
    children: Vec<Child>,
}

#[derive(Clone, Debug)]
enum Child {
    Group(usize),
    Path {
        id: String,
        path_id: String,
        visible: bool,
        transform: Option<GroupTransform>,
    },
}

impl ShapeGraphTrack {
    fn serialize_path<S: Serializer>(
        path: &Arc<EvaluatedPath>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        path.as_ref().serialize(serializer)
    }

    pub fn evaluate(&self, time: f64) -> Result<Vec<FlattenedShapePath>, EvaluationError> {
        if !time.is_finite() {
            return Err(EvaluationError::InvalidTime);
        }
        let mut evaluation = GraphEvaluation {
            time,
            output: Vec::new(),
            remaining: self.limits.max_shape_walk_operations,
        };
        for &index in &self.roots {
            if evaluation.output.len() >= self.limits.max_shape_instances.min(4096) {
                break;
            }
            self.visit(
                index,
                GraphVisit {
                    matrix: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
                    opacity: 1.0,
                    depth: 1,
                },
                &mut evaluation,
            )?;
        }
        Ok(evaluation.output)
    }

    fn visit(
        &self,
        index: usize,
        parent: GraphVisit,
        evaluation: &mut GraphEvaluation,
    ) -> Result<(), EvaluationError> {
        evaluation.charge()?;
        let group = &self.groups[index];
        if !group.visible || parent.depth > self.limits.max_shape_depth.min(64) {
            return Ok(());
        }
        let (matrix, opacity) = group.transform.evaluate(evaluation.time)?;
        let matrix = GroupTransform::multiply(parent.matrix, matrix);
        let opacity = parent.opacity * opacity;
        for child in &group.children {
            if evaluation.output.len() >= self.limits.max_shape_instances.min(4096) {
                break;
            }
            evaluation.charge()?;
            match child {
                Child::Group(index) => self.visit(
                    *index,
                    GraphVisit {
                        matrix,
                        opacity,
                        depth: parent.depth + 1,
                    },
                    evaluation,
                )?,
                Child::Path {
                    id,
                    path_id,
                    visible,
                    transform,
                } => {
                    if !visible {
                        continue;
                    }
                    let (child_matrix, child_opacity) = match transform {
                        Some(t) => t.evaluate(evaluation.time)?,
                        None => ([1.0, 0.0, 0.0, 1.0, 0.0, 0.0], 1.0),
                    };
                    let path = self.paths.get(path_id).ok_or_else(|| {
                        EvaluationError::InvalidScene("missing shape resource".into())
                    })?;
                    evaluation.output.push(FlattenedShapePath {
                        instance_id: id.clone(),
                        path_id: path_id.clone(),
                        path: Arc::clone(path),
                        matrix: GroupTransform::multiply(matrix, child_matrix),
                        opacity: opacity * child_opacity,
                    });
                }
            }
        }
        Ok(())
    }

    pub fn masks(&self, layer: &aster_types::editor::Layer) -> Vec<ResolvedMaskPath> {
        let mut output = Vec::new();
        for effect in &layer.effects {
            let Some(mask) = effect.mask.value().filter(|mask| mask.shape == "path") else {
                continue;
            };
            let Some(id) = mask.path_id.value() else {
                continue;
            };
            let Some(path) = self.paths.get(id) else {
                continue;
            };
            output.push(ResolvedMaskPath {
                effect_id: effect.id.clone(),
                path_id: id.clone(),
                path: Arc::clone(path),
                opacity: (mask.opacity.as_f64().unwrap_or(100.0) / 100.0).clamp(0.0, 1.0),
                feather: mask.feather.as_f64().unwrap_or(0.0).clamp(0.0, 1_000_000.0),
                invert: mask.invert,
            });
        }
        output
    }
}

struct GraphVisit {
    matrix: [f64; 6],
    opacity: f64,
    depth: usize,
}
struct GraphEvaluation {
    time: f64,
    output: Vec<FlattenedShapePath>,
    remaining: usize,
}
impl GraphEvaluation {
    fn charge(&mut self) -> Result<(), EvaluationError> {
        self.remaining = self.remaining.checked_sub(1).ok_or_else(|| {
            EvaluationError::InvalidScene("shape graph traversal budget exceeded".into())
        })?;
        Ok(())
    }
}

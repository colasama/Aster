use super::{Child, Group, GroupTransform, ShapeGraphLimits, ShapeGraphTrack};
use crate::{EvaluatedPath, EvaluationError, EvaluationLimits, PathLimits};
use aster_types::editor::{Field, ShapeChild, ShapeGraph};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

impl ShapeGraphTrack {
    pub fn compile(
        graph: &ShapeGraph,
        limits: &ShapeGraphLimits,
        path_limits: &PathLimits,
        evaluation: &EvaluationLimits,
    ) -> Result<Self, EvaluationError> {
        Self::identifier(&graph.id)?;
        Self::revision(&graph.revision)?;
        if graph.paths.len() > limits.max_shape_paths.min(1024)
            || graph.groups.len() > limits.max_shape_groups.min(512)
            || graph.root_group_ids.len() > limits.max_shape_groups.min(512)
        {
            return Err(EvaluationError::InvalidScene(
                "shape graph resource budget exceeded".into(),
            ));
        }
        let mut paths = BTreeMap::new();
        let mut total = 0usize;
        for resource in &graph.paths {
            Self::identifier(&resource.id)?;
            Self::revision(&resource.revision)?;
            total = total.saturating_add(resource.path.vertices.len());
            if resource.path.vertices.len() < 2
                || resource.path.vertices.len() > 512
                || total > limits.max_shape_vertices.min(65_536)
            {
                return Err(EvaluationError::InvalidScene(
                    "shape graph path vertex budget exceeded".into(),
                ));
            }
            let path = Arc::new(EvaluatedPath::compile(&resource.path, path_limits)?);
            if paths.insert(resource.id.clone(), path).is_some() {
                return Err(EvaluationError::InvalidScene(
                    "duplicate shape resource identity".into(),
                ));
            }
        }
        let mut group_ids = BTreeMap::new();
        for (index, group) in graph.groups.iter().enumerate() {
            Self::identifier(&group.id)?;
            Self::identifier(&group.name)?;
            if group_ids.insert(group.id.clone(), index).is_some() {
                return Err(EvaluationError::InvalidScene(
                    "duplicate shape group identity".into(),
                ));
            }
        }
        let mut groups = Vec::with_capacity(graph.groups.len());
        let mut instance_ids = BTreeSet::new();
        for group in &graph.groups {
            if group.children.len() > limits.max_shape_children.min(1024) {
                return Err(EvaluationError::InvalidScene(
                    "shape group child budget exceeded".into(),
                ));
            }
            let mut children = Vec::with_capacity(group.children.len());
            for child in &group.children {
                let (id, compiled) = match child {
                    ShapeChild::Group { id, group_id, .. } => {
                        Self::identifier(group_id)?;
                        let index = group_ids.get(group_id).ok_or_else(|| {
                            EvaluationError::InvalidScene("missing shape group reference".into())
                        })?;
                        (id, Child::Group(*index))
                    }
                    ShapeChild::Path {
                        id,
                        path_id,
                        visible,
                        transform,
                        ..
                    } => {
                        Self::identifier(path_id)?;
                        if !paths.contains_key(path_id) {
                            return Err(EvaluationError::InvalidScene(
                                "missing shape path reference".into(),
                            ));
                        }
                        let transform = match transform {
                            Field::Absent => None,
                            Field::Null => {
                                return Err(EvaluationError::InvalidScene(
                                    "null shape transform".into(),
                                ));
                            }
                            Field::Value(value) => {
                                Some(GroupTransform::compile(value, evaluation)?)
                            }
                        };
                        (
                            id,
                            Child::Path {
                                id: id.clone(),
                                path_id: path_id.clone(),
                                visible: *visible,
                                transform,
                            },
                        )
                    }
                };
                Self::identifier(id)?;
                if !instance_ids.insert(id.clone())
                    || instance_ids.len() > limits.max_shape_instances.min(4096)
                {
                    return Err(EvaluationError::InvalidScene(
                        "duplicate or over-budget shape instance".into(),
                    ));
                }
                children.push(compiled);
            }
            groups.push(Group {
                visible: group.visible,
                transform: GroupTransform::compile(&group.transform, evaluation)?,
                children,
            });
        }
        let mut roots = Vec::new();
        let mut root_ids = BTreeSet::new();
        for id in &graph.root_group_ids {
            Self::identifier(id)?;
            if !root_ids.insert(id) {
                return Err(EvaluationError::InvalidScene("duplicate shape root".into()));
            }
            roots.push(
                *group_ids
                    .get(id)
                    .ok_or_else(|| EvaluationError::InvalidScene("missing shape root".into()))?,
            );
        }
        let result = Self {
            paths,
            groups,
            roots,
            limits: limits.clone(),
        };
        let mut complete = vec![false; result.groups.len()];
        let mut stack = complete.clone();
        for index in 0..result.groups.len() {
            result.validate_cycles(index, 1, &mut complete, &mut stack)?;
        }
        Ok(result)
    }

    fn validate_cycles(
        &self,
        index: usize,
        depth: usize,
        complete: &mut [bool],
        stack: &mut [bool],
    ) -> Result<(), EvaluationError> {
        if complete[index] {
            return Ok(());
        }
        if stack[index] || depth > self.limits.max_shape_depth.min(64) {
            return Err(EvaluationError::InvalidScene(
                "shape group cycle or depth limit exceeded".into(),
            ));
        }
        stack[index] = true;
        for child in &self.groups[index].children {
            if let Child::Group(index) = child {
                self.validate_cycles(*index, depth + 1, complete, stack)?;
            }
        }
        stack[index] = false;
        complete[index] = true;
        Ok(())
    }

    fn identifier(value: &str) -> Result<(), EvaluationError> {
        if value.is_empty() || value.encode_utf16().count() > 256 {
            return Err(EvaluationError::InvalidScene(
                "invalid shape identity".into(),
            ));
        }
        Ok(())
    }

    fn revision(value: &serde_json::Number) -> Result<(), EvaluationError> {
        if value
            .as_f64()
            .is_none_or(|v| v.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&v))
        {
            return Err(EvaluationError::InvalidScene(
                "invalid shape revision".into(),
            ));
        }
        Ok(())
    }
}

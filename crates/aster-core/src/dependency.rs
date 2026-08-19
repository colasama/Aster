use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::IndexSet;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

pub type NodeId = Uuid;

/// Tracks downstream invalidation without recomputing unaffected nodes.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct DependencyGraph {
    dependencies: HashMap<NodeId, IndexSet<NodeId>>,
    dependents: HashMap<NodeId, IndexSet<NodeId>>,
    dirty: HashSet<NodeId>,
}

impl DependencyGraph {
    pub fn add_node(&mut self, id: NodeId) {
        self.dependencies.entry(id).or_default();
        self.dependents.entry(id).or_default();
    }

    /// Adds an edge where `node` consumes the output of `dependency`.
    pub fn add_dependency(
        &mut self,
        node: NodeId,
        dependency: NodeId,
    ) -> Result<(), DependencyError> {
        if node == dependency {
            return Err(DependencyError::Cycle);
        }
        self.add_node(node);
        self.add_node(dependency);
        if self.reaches(node, dependency) {
            return Err(DependencyError::Cycle);
        }
        self.dependencies
            .entry(node)
            .or_default()
            .insert(dependency);
        self.dependents.entry(dependency).or_default().insert(node);
        Ok(())
    }

    pub fn mark_dirty(&mut self, root: NodeId) -> EvaluationStats {
        let mut queue = VecDeque::from([root]);
        let mut visited = HashSet::new();
        while let Some(node) = queue.pop_front() {
            if !visited.insert(node) {
                continue;
            }
            self.dirty.insert(node);
            if let Some(dependents) = self.dependents.get(&node) {
                queue.extend(dependents.iter().copied());
            }
        }
        EvaluationStats {
            dirty_nodes: visited.len(),
            total_nodes: self.dependencies.len(),
        }
    }

    pub fn take_evaluation_order(&mut self) -> Result<Vec<NodeId>, DependencyError> {
        let order = self.topological_order()?;
        let dirty_order = order
            .into_iter()
            .filter(|node| self.dirty.remove(node))
            .collect();
        Ok(dirty_order)
    }

    pub fn topological_order(&self) -> Result<Vec<NodeId>, DependencyError> {
        let mut pending: HashMap<_, _> = self
            .dependencies
            .iter()
            .map(|(node, dependencies)| (*node, dependencies.len()))
            .collect();
        let mut queue: VecDeque<_> = pending
            .iter()
            .filter_map(|(node, count)| (*count == 0).then_some(*node))
            .collect();
        let mut order = Vec::with_capacity(pending.len());
        while let Some(node) = queue.pop_front() {
            order.push(node);
            if let Some(dependents) = self.dependents.get(&node) {
                for dependent in dependents {
                    let count = pending.get_mut(dependent).expect("registered node");
                    *count -= 1;
                    if *count == 0 {
                        queue.push_back(*dependent);
                    }
                }
            }
        }
        if order.len() != pending.len() {
            return Err(DependencyError::Cycle);
        }
        Ok(order)
    }

    fn reaches(&self, start: NodeId, target: NodeId) -> bool {
        let mut queue = VecDeque::from([start]);
        let mut visited = HashSet::new();
        while let Some(node) = queue.pop_front() {
            if node == target {
                return true;
            }
            if visited.insert(node)
                && let Some(dependents) = self.dependents.get(&node)
            {
                queue.extend(dependents.iter().copied());
            }
        }
        false
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct EvaluationStats {
    pub dirty_nodes: usize,
    pub total_nodes: usize,
}

#[derive(Clone, Copy, Debug, Error, PartialEq)]
pub enum DependencyError {
    #[error("dependency would create a cycle")]
    Cycle,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn propagates_only_to_downstream_nodes() {
        let source = Uuid::new_v4();
        let effect = Uuid::new_v4();
        let composite = Uuid::new_v4();
        let unrelated = Uuid::new_v4();
        let mut graph = DependencyGraph::default();
        graph.add_node(unrelated);
        graph.add_dependency(effect, source).unwrap();
        graph.add_dependency(composite, effect).unwrap();
        let stats = graph.mark_dirty(effect);
        let order = graph.take_evaluation_order().unwrap();
        assert_eq!(stats.dirty_nodes, 2);
        assert_eq!(order, vec![effect, composite]);
        assert!(!order.contains(&unrelated));
    }

    #[test]
    fn rejects_cycles() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let mut graph = DependencyGraph::default();
        graph.add_dependency(b, a).unwrap();
        assert_eq!(graph.add_dependency(a, b), Err(DependencyError::Cycle));
    }
}

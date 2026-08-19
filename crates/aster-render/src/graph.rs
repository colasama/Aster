use std::collections::{HashMap, HashSet, VecDeque};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ResourceHandle(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct PassId(pub u32);

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct ResourceDescriptor {
    pub width: u32,
    pub height: u32,
    pub format: TextureFormat,
    pub samples: u8,
    pub transient: bool,
}

impl ResourceDescriptor {
    pub fn estimated_bytes(self) -> u64 {
        u64::from(self.width)
            * u64::from(self.height)
            * self.format.bytes_per_pixel()
            * u64::from(self.samples.max(1))
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TextureFormat {
    Rgba8Unorm,
    Rgba8UnormSrgb,
    Rgba16Float,
    Rg16Float,
    R32Float,
    R32Uint,
    Depth32Float,
}

impl TextureFormat {
    const fn bytes_per_pixel(self) -> u64 {
        match self {
            Self::Rgba8Unorm | Self::Rgba8UnormSrgb | Self::R32Float | Self::R32Uint => 4,
            Self::Rg16Float => 4,
            Self::Rgba16Float => 8,
            Self::Depth32Float => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PassKind {
    Render,
    Compute,
    Copy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Pass {
    pub id: PassId,
    pub name: String,
    pub kind: PassKind,
    pub reads: Vec<ResourceHandle>,
    pub writes: Vec<ResourceHandle>,
    pub dependencies: Vec<PassId>,
}

#[derive(Clone, Debug, Default)]
pub struct RenderGraph {
    resources: IndexMap<ResourceHandle, ResourceDescriptor>,
    passes: IndexMap<PassId, Pass>,
    next_resource: u32,
    next_pass: u32,
}

impl RenderGraph {
    pub fn create_resource(&mut self, descriptor: ResourceDescriptor) -> ResourceHandle {
        let handle = ResourceHandle(self.next_resource);
        self.next_resource += 1;
        self.resources.insert(handle, descriptor);
        handle
    }

    pub fn add_pass(
        &mut self,
        name: impl Into<String>,
        kind: PassKind,
        reads: Vec<ResourceHandle>,
        writes: Vec<ResourceHandle>,
        dependencies: Vec<PassId>,
    ) -> PassId {
        let id = PassId(self.next_pass);
        self.next_pass += 1;
        self.passes.insert(
            id,
            Pass {
                id,
                name: name.into(),
                kind,
                reads,
                writes,
                dependencies,
            },
        );
        id
    }

    pub fn compile(&self) -> Result<CompiledGraph, RenderGraphError> {
        self.validate_handles()?;
        let dependencies = self.derive_dependencies();
        let order = topological_order(self.passes.keys().copied(), &dependencies)?;
        let allocations = self.allocate_transients(&order);
        let estimated_vram_bytes = allocations
            .iter()
            .filter_map(|allocation| self.resources.get(&allocation.resource))
            .map(|descriptor| descriptor.estimated_bytes())
            .sum();
        Ok(CompiledGraph {
            passes: order
                .into_iter()
                .map(|id| self.passes[&id].clone())
                .collect(),
            allocations,
            estimated_vram_bytes,
        })
    }

    pub fn to_dot(&self) -> String {
        let dependencies = self.derive_dependencies();
        let mut output = String::from("digraph RenderGraph {\n");
        for pass in self.passes.values() {
            output.push_str(&format!(
                "  p{} [label=\"{}\\n{:?}\"];\n",
                pass.id.0, pass.name, pass.kind
            ));
        }
        for (node, inputs) in dependencies {
            for input in inputs {
                output.push_str(&format!("  p{} -> p{};\n", input.0, node.0));
            }
        }
        output.push_str("}\n");
        output
    }

    fn validate_handles(&self) -> Result<(), RenderGraphError> {
        for pass in self.passes.values() {
            for resource in pass.reads.iter().chain(&pass.writes) {
                if !self.resources.contains_key(resource) {
                    return Err(RenderGraphError::MissingResource(*resource));
                }
            }
            for dependency in &pass.dependencies {
                if !self.passes.contains_key(dependency) {
                    return Err(RenderGraphError::MissingPass(*dependency));
                }
            }
        }
        Ok(())
    }

    fn derive_dependencies(&self) -> HashMap<PassId, HashSet<PassId>> {
        let mut result: HashMap<_, HashSet<_>> = self
            .passes
            .values()
            .map(|pass| (pass.id, pass.dependencies.iter().copied().collect()))
            .collect();
        let mut last_writer: HashMap<ResourceHandle, PassId> = HashMap::new();
        let mut readers: HashMap<ResourceHandle, HashSet<PassId>> = HashMap::new();
        for pass in self.passes.values() {
            for resource in &pass.reads {
                if let Some(writer) = last_writer.get(resource) {
                    result.entry(pass.id).or_default().insert(*writer);
                }
                readers.entry(*resource).or_default().insert(pass.id);
            }
            for resource in &pass.writes {
                if let Some(writer) = last_writer.insert(*resource, pass.id) {
                    result.entry(pass.id).or_default().insert(writer);
                }
                if let Some(previous_readers) = readers.remove(resource) {
                    result.entry(pass.id).or_default().extend(previous_readers);
                    result.entry(pass.id).or_default().remove(&pass.id);
                }
            }
        }
        result
    }

    fn allocate_transients(&self, order: &[PassId]) -> Vec<TransientAllocation> {
        let pass_index: HashMap<_, _> = order
            .iter()
            .enumerate()
            .map(|(index, id)| (*id, index))
            .collect();
        let mut lifetimes: HashMap<ResourceHandle, (usize, usize)> = HashMap::new();
        for pass in self.passes.values() {
            let index = pass_index[&pass.id];
            for resource in pass.reads.iter().chain(&pass.writes) {
                lifetimes
                    .entry(*resource)
                    .and_modify(|range| range.1 = range.1.max(index))
                    .or_insert((index, index));
            }
        }
        let mut allocations = Vec::new();
        let mut slots: Vec<(ResourceDescriptor, usize, u32)> = Vec::new();
        for (resource, descriptor) in &self.resources {
            let Some((first_use, last_use)) = lifetimes.get(resource).copied() else {
                continue;
            };
            let slot = if descriptor.transient {
                slots
                    .iter_mut()
                    .find(|(existing, available_after, _)| {
                        existing.width == descriptor.width
                            && existing.height == descriptor.height
                            && existing.format == descriptor.format
                            && existing.samples == descriptor.samples
                            && *available_after < first_use
                    })
                    .map(|(_, available_after, slot)| {
                        *available_after = last_use;
                        *slot
                    })
            } else {
                None
            }
            .unwrap_or_else(|| {
                let slot = slots.len() as u32;
                slots.push((*descriptor, last_use, slot));
                slot
            });
            allocations.push(TransientAllocation {
                resource: *resource,
                slot,
                first_use,
                last_use,
            });
        }
        allocations
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CompiledGraph {
    pub passes: Vec<Pass>,
    pub allocations: Vec<TransientAllocation>,
    pub estimated_vram_bytes: u64,
}

impl CompiledGraph {
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct TransientAllocation {
    pub resource: ResourceHandle,
    pub slot: u32,
    pub first_use: usize,
    pub last_use: usize,
}

fn topological_order(
    nodes: impl Iterator<Item = PassId>,
    dependencies: &HashMap<PassId, HashSet<PassId>>,
) -> Result<Vec<PassId>, RenderGraphError> {
    let mut pending: HashMap<_, _> = nodes
        .map(|node| (node, dependencies.get(&node).map_or(0, HashSet::len)))
        .collect();
    let mut dependents: HashMap<PassId, Vec<PassId>> = HashMap::new();
    for (node, inputs) in dependencies {
        for input in inputs {
            dependents.entry(*input).or_default().push(*node);
        }
    }
    let mut queue: VecDeque<_> = pending
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(*id))
        .collect();
    let mut result = Vec::with_capacity(pending.len());
    while let Some(node) = queue.pop_front() {
        result.push(node);
        for dependent in dependents.get(&node).into_iter().flatten() {
            let count = pending.get_mut(dependent).expect("known dependency");
            *count -= 1;
            if *count == 0 {
                queue.push_back(*dependent);
            }
        }
    }
    if result.len() != pending.len() {
        return Err(RenderGraphError::Cycle);
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug, Error, PartialEq)]
pub enum RenderGraphError {
    #[error("render graph contains a cycle")]
    Cycle,
    #[error("resource {0:?} does not exist")]
    MissingResource(ResourceHandle),
    #[error("pass {0:?} does not exist")]
    MissingPass(PassId),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texture() -> ResourceDescriptor {
        ResourceDescriptor {
            width: 3840,
            height: 2160,
            format: TextureFormat::Rgba16Float,
            samples: 1,
            transient: true,
        }
    }

    #[test]
    fn schedules_data_dependencies() {
        let mut graph = RenderGraph::default();
        let source = graph.create_resource(texture());
        let blurred = graph.create_resource(texture());
        let output = graph.create_resource(texture());
        let upload = graph.add_pass("upload", PassKind::Copy, vec![], vec![source], vec![]);
        let blur = graph.add_pass(
            "blur",
            PassKind::Compute,
            vec![source],
            vec![blurred],
            vec![],
        );
        let composite = graph.add_pass(
            "composite",
            PassKind::Render,
            vec![blurred],
            vec![output],
            vec![],
        );
        let compiled = graph.compile().unwrap();
        let ids: Vec<_> = compiled.passes.iter().map(|pass| pass.id).collect();
        assert_eq!(ids, vec![upload, blur, composite]);
    }

    #[test]
    fn reuses_non_overlapping_transient_textures() {
        let mut graph = RenderGraph::default();
        let a = graph.create_resource(texture());
        let b = graph.create_resource(texture());
        let pass_a = graph.add_pass("a", PassKind::Compute, vec![], vec![a], vec![]);
        graph.add_pass("consume a", PassKind::Compute, vec![a], vec![], vec![]);
        graph.add_pass("b", PassKind::Compute, vec![], vec![b], vec![pass_a]);
        let compiled = graph.compile().unwrap();
        assert!(compiled.allocations.len() >= 2);
    }
}

use std::{collections::BTreeMap, sync::Arc};

use aster_render_ir::{GeneratorGraph, ResourceHash};

use crate::{RenderError, generator_input::GeneratorInput};

/// Only the reviewed, complete writer and its bounded readers may reuse nonzero storage.
#[derive(Clone)]
pub(crate) struct GeneratorOverwrite {
    compute: Arc<str>,
    render: Arc<str>,
}

impl GeneratorOverwrite {
    pub fn new(catalog: &aster_shaders::ShaderCatalog) -> Result<Self, RenderError> {
        Ok(Self {
            compute: Arc::from(catalog.program("particle-compute")?.source.as_str()),
            render: Arc::from(catalog.program("particle-render")?.source.as_str()),
        })
    }

    pub fn program(
        &self,
        graph: &GeneratorGraph,
        shaders: &BTreeMap<ResourceHash, Arc<str>>,
    ) -> Result<bool, RenderError> {
        if graph.instance_stride != 48 || graph.compute_passes.len() != 1 {
            return Ok(false);
        }
        let pass = &graph.compute_passes[0];
        if pass.entry_point != "compute_main" || pass.workgroup_size != [256, 1, 1] {
            return Ok(false);
        }
        if shaders.get(&pass.shader).map(AsRef::as_ref) != Some(self.compute.as_ref()) {
            return Ok(false);
        }
        for variant in &graph.render_variants {
            let (fragment, auxiliary, vertices) = match variant.vertex_entry.as_str() {
                "billboard_vertex" => ("billboard_fragment", "billboard_auxiliary", 6),
                "streak_vertex" => ("streak_fragment", "streak_auxiliary", 6),
                "mesh_vertex" => ("mesh_fragment", "mesh_auxiliary", 36),
                _ => return Ok(false),
            };
            if shaders.get(&variant.shader).map(AsRef::as_ref) != Some(self.render.as_ref())
                || variant.fragment_entry != fragment
                || variant.vertex_count != vertices
                || variant.auxiliary.as_ref().is_some_and(|a| {
                    shaders.get(&a.shader).map(AsRef::as_ref) != Some(self.render.as_ref())
                        || a.vertex_entry != variant.vertex_entry
                        || a.fragment_entry != auxiliary
                })
            {
                return Ok(false);
            }
        }
        Ok(!graph.render_variants.is_empty())
    }

    pub fn invocation(input: &GeneratorInput) -> bool {
        let invocation = &input.invocation;
        // The writer covers every drawn instance, including invisible ones. The validated
        // indirect payload starts at instance zero; capacity beyond the count is never read.
        invocation.effective_count > 0
            && invocation.capacity >= invocation.effective_count
            && invocation.dispatches == [[invocation.effective_count.div_ceil(256), 1, 1]]
            && invocation.validate_payload(&input.payload).is_ok()
    }
}

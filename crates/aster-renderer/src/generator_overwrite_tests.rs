use std::{collections::BTreeMap, sync::Arc};

use aster_render_ir::{
    CompositionIdentity, EffectBlendMode, GeneratorAuxiliary, GeneratorBlend, GeneratorCompute,
    GeneratorCull, GeneratorDepth, GeneratorGraph, GeneratorPhase, GeneratorProgram,
    GeneratorVariant, ResourceHash, SceneGeneratorSlice,
};

use crate::{generator_input::GeneratorInput, generator_overwrite::GeneratorOverwrite};

struct OverwriteFixture;
impl OverwriteFixture {
    fn input() -> Result<GeneratorInput, Box<dyn std::error::Error>> {
        let catalog = aster_shaders::ShaderCatalog::embedded()?;
        let compute = ResourceHash("a".repeat(64));
        let render = ResourceHash("b".repeat(64));
        let graph = GeneratorGraph {
            api_version: 1,
            max_instances: 1_000_000,
            instance_stride: 48,
            compute_passes: vec![GeneratorCompute {
                id: "simulate".into(),
                shader: compute.clone(),
                entry_point: "compute_main".into(),
                workgroup_size: [256, 1, 1],
                phase: GeneratorPhase::Simulation,
            }],
            render_variants: ["billboard", "streak", "mesh"]
                .into_iter()
                .map(|name| GeneratorVariant {
                    id: name.into(),
                    shader: render.clone(),
                    vertex_entry: format!("{name}_vertex"),
                    fragment_entry: format!("{name}_fragment"),
                    vertex_count: if name == "mesh" { 36 } else { 6 },
                    blend: GeneratorBlend::Layer,
                    depth: GeneratorDepth::None,
                    cull: GeneratorCull::None,
                    auxiliary: Some(GeneratorAuxiliary {
                        shader: render.clone(),
                        vertex_entry: format!("{name}_vertex"),
                        fragment_entry: format!("{name}_auxiliary"),
                    }),
                })
                .collect(),
        };
        let identity = CompositionIdentity::Unicode("arbitrary-plugin-id".into());
        let invocation = SceneGeneratorSlice {
            blob_index: 0,
            instance_id: identity.clone(),
            selection_id: identity.clone(),
            blend_mode: EffectBlendMode::Screen,
            program: GeneratorProgram {
                source_key: identity.clone(),
                label: identity,
                audio_analysis: false,
                graph,
            },
            variant_index: 0,
            requested_count: 257,
            effective_count: 257,
            capacity: 1024,
            dispatches: vec![[2, 1, 1]],
            has_audio: false,
        };
        let mut payload = vec![0; 2272];
        payload[24..28].copy_from_slice(&257_u32.to_le_bytes());
        payload[2256..2260].copy_from_slice(&6_u32.to_le_bytes());
        Ok(GeneratorInput {
            invocation,
            payload,
            audio: None,
            shaders: BTreeMap::from([
                (
                    compute,
                    Arc::from(catalog.program("particle-compute")?.source.as_str()),
                ),
                (
                    render,
                    Arc::from(catalog.program("particle-render")?.source.as_str()),
                ),
            ]),
            program_key: ResourceHash("c".repeat(64)),
        })
    }
}

#[test]
fn storage_overwrite_requires_complete_writer_and_bounded_readers()
-> Result<(), Box<dyn std::error::Error>> {
    let mut input = OverwriteFixture::input()?;
    let overwrite = GeneratorOverwrite::new(&aster_shaders::ShaderCatalog::embedded()?)?;
    let original = input.invocation.program.graph.clone();
    assert!(overwrite.program(&original, &input.shaders)?);
    assert!(GeneratorOverwrite::invocation(&input));
    for change in 0..8 {
        let mut graph = original.clone();
        match change {
            0 => graph.instance_stride = 64,
            1 => graph.compute_passes.push(graph.compute_passes[0].clone()),
            2 => graph.compute_passes[0].workgroup_size = [128, 1, 1],
            3 => graph.compute_passes[0].entry_point = "other".into(),
            4 => graph.render_variants[0].shader = ResourceHash("d".repeat(64)),
            5 => graph.render_variants[0].vertex_count = 12,
            6 => graph.render_variants[0].vertex_entry = "other".into(),
            _ => {
                graph.render_variants[0]
                    .auxiliary
                    .as_mut()
                    .ok_or("auxiliary absent")?
                    .fragment_entry = "other".into()
            }
        }
        assert!(!overwrite.program(&graph, &input.shaders)?);
    }
    for hash in input.shaders.keys().cloned().collect::<Vec<_>>() {
        let mut shaders = input.shaders.clone();
        shaders.insert(
            hash,
            Arc::from("untrusted shader with identical plugin identity"),
        );
        assert!(!overwrite.program(&original, &shaders)?);
    }
    input.invocation.dispatches[0][0] = 1;
    assert!(!GeneratorOverwrite::invocation(&input));
    input.invocation.dispatches[0][0] = 2;
    for offset in [24, 2256, 2260, 2264, 2268] {
        input.payload[offset] ^= 1;
        assert!(!GeneratorOverwrite::invocation(&input));
        input.payload[offset] ^= 1;
    }
    Ok(())
}

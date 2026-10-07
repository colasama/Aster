use std::collections::BTreeMap;

use aster_render_ir::{
    CompositionIdentity, ResourceHash, RootCommandRecord, RootLoadOp, RootTextureReference,
};

use super::{LayerFixture, NativeRenderer};
use crate::{
    SuppliedFrame,
    layer_key::LayerKey,
    surface_generation::SurfaceGenerations,
    surface_plan::{SurfaceInput, SurfacePlan},
};

pub(super) struct RecursiveFixture;

impl RecursiveFixture {
    pub(super) fn frame()
    -> Result<(SuppliedFrame, aster_render_ir::ResourceRegistry), Box<dyn std::error::Error>> {
        let (mut root, registry) = LayerFixture::frame()?;
        let (mut leaf, _) = LayerFixture::frame()?;
        let (mut middle, _) = LayerFixture::frame()?;
        for scene in [&mut root.scene, &mut leaf.scene, &mut middle.scene] {
            let mut vertices = Vec::new();
            for (x, y, u, v) in [
                (-1.0_f32, -1.0, 0.0, 1.0),
                (1.0, -1.0, 1.0, 1.0),
                (-1.0, 1.0, 0.0, 0.0),
                (-1.0, 1.0, 0.0, 0.0),
                (1.0, -1.0, 1.0, 1.0),
                (1.0, 1.0, 1.0, 0.0),
            ] {
                let mut values = [0.0_f32; 40];
                values[..9].copy_from_slice(&[x, y, 0.0, u, v, 0.6, 0.3, 0.2, 0.7]);
                vertices.extend(values.into_iter().flat_map(f32::to_le_bytes));
            }
            scene.vertices = vertices;
            for draw in &mut scene.root.draws {
                draw.first_vertex = 0;
                draw.vertex_count = 6;
            }
            scene.layers.get_mut(&999).ok_or("layer")?.uniforms[68..72]
                .copy_from_slice(&1_f32.to_le_bytes());
        }
        middle.scene.root.draws.first_mut().ok_or("draw")?.texture =
            RootTextureReference::Surface {
                instance_id: CompositionIdentity::Unicode("leaf-alias".into()),
            };
        root.scene.root.draws.first_mut().ok_or("draw")?.texture = RootTextureReference::Surface {
            instance_id: CompositionIdentity::Unicode("middle".into()),
        };
        root.surfaces = SurfacePlan {
            targets: vec![
                SurfaceInput {
                    key: "leaf".encode_utf16().collect(),
                    size: leaf.scene.header.render_target,
                    scene: leaf.scene,
                },
                SurfaceInput {
                    key: "middle".encode_utf16().collect(),
                    size: middle.scene.header.render_target,
                    scene: middle.scene,
                },
            ],
            bindings: BTreeMap::from([
                ("leaf".encode_utf16().collect(), 0),
                ("leaf-alias".encode_utf16().collect(), 0),
                ("middle".encode_utf16().collect(), 1),
            ]),
        };
        Ok((root, registry))
    }

    fn key(frame: &SuppliedFrame) -> Result<ResourceHash, Box<dyn std::error::Error>> {
        let generations = SurfaceGenerations::collect(&frame.surfaces)?;
        Ok(LayerKey::collect(&frame.scene, &generations)?
            .remove(&2)
            .ok_or("root key absent")?
            .hash)
    }

    pub fn verify_gpu(renderer: &mut NativeRenderer) -> Result<(), Box<dyn std::error::Error>> {
        let (mut frame, registry) = Self::frame()?;
        let first = LayerFixture::pixels(renderer, &frame, &registry)?;
        assert!(
            first
                .chunks_exact(4)
                .any(|pixel| pixel[0] > 0 && pixel[3] > 0)
        );
        let before = renderer.layer_cache.statistics;
        assert_eq!(LayerFixture::pixels(renderer, &frame, &registry)?, first);
        assert!(renderer.layer_cache.statistics.hits >= before.hits + 3);
        assert_eq!(
            renderer.layer_cache.statistics.allocations,
            before.allocations
        );
        for vertex in frame.surfaces.targets[0]
            .scene
            .vertices
            .chunks_exact_mut(160)
        {
            vertex[20..24].copy_from_slice(&0.1_f32.to_le_bytes());
        }
        let changed = LayerFixture::pixels(renderer, &frame, &registry)?;
        assert_ne!(changed, first);
        assert!(renderer.layer_cache.statistics.stores >= before.stores + 3);
        renderer.options.layer_cache_bytes = 0;
        assert_eq!(LayerFixture::pixels(renderer, &frame, &registry)?, changed);
        assert_eq!(renderer.layer_cache.statistics.resident_bytes, 0);
        Ok(())
    }
}

#[test]
fn recursive_generations_cover_aliases_children_effects_and_unknown_history()
-> Result<(), Box<dyn std::error::Error>> {
    let (mut frame, _) = RecursiveFixture::frame()?;
    let initial = RecursiveFixture::key(&frame)?;
    let generations = SurfaceGenerations::collect(&frame.surfaces)?;
    assert_eq!(
        generations.get(&"leaf".encode_utf16().collect::<Vec<_>>()),
        generations.get(&"leaf-alias".encode_utf16().collect::<Vec<_>>())
    );
    frame.surfaces.targets[0].scene.vertices[20..24].copy_from_slice(&0.1_f32.to_le_bytes());
    assert_ne!(RecursiveFixture::key(&frame)?, initial);
    let before = RecursiveFixture::key(&frame)?;
    frame.surfaces.targets[0].scene.clears[0][0] = 0.4;
    assert_ne!(RecursiveFixture::key(&frame)?, before);
    let before = RecursiveFixture::key(&frame)?;
    frame.surfaces.targets[0]
        .scene
        .layers
        .get_mut(&999)
        .ok_or("layer")?
        .uniforms[12..16]
        .copy_from_slice(&2_f32.to_le_bytes());
    assert_ne!(RecursiveFixture::key(&frame)?, before);
    let before = RecursiveFixture::key(&frame)?;
    frame.surfaces.targets[0]
        .scene
        .layers
        .get_mut(&999)
        .ok_or("layer")?
        .uniforms[8..12]
        .copy_from_slice(&5_f32.to_le_bytes());
    assert_eq!(RecursiveFixture::key(&frame)?, before);
    let RootCommandRecord::BeginScene { color_load, .. } =
        &mut frame.surfaces.targets[0].scene.root.commands[0]
    else {
        return Err("begin scene absent".into());
    };
    *color_load = RootLoadOp::Load;
    let generations = SurfaceGenerations::collect(&frame.surfaces)?;
    assert!(generations.is_empty());
    assert!(LayerKey::collect(&frame.scene, &generations)?.is_empty());
    Ok(())
}

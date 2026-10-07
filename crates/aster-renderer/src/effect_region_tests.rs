use crate::{
    SuppliedFrame,
    effect_region::{EffectRegions, PixelRegion},
    surface_plan::SurfacePlan,
};

use super::{LayerFixture, NativeRenderer, surface_generation_tests::RecursiveFixture};

pub(super) struct RegionFixture;

impl RegionFixture {
    fn frame()
    -> Result<(SuppliedFrame, aster_render_ir::ResourceRegistry), Box<dyn std::error::Error>> {
        let (mut frame, registry) = RecursiveFixture::frame()?;
        frame.scene = frame.surfaces.targets.remove(0).scene;
        frame.surfaces = SurfacePlan::default();
        for vertex in frame.scene.vertices.chunks_exact_mut(160) {
            for offset in [0, 4] {
                let value = f32::from_le_bytes(vertex[offset..offset + 4].try_into()?) * 0.25;
                vertex[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
        }
        Ok((frame, registry))
    }

    pub fn verify_gpu(renderer: &mut NativeRenderer) -> Result<(), Box<dyn std::error::Error>> {
        let (mut frame, registry) = Self::frame()?;
        renderer.options.layer_cache_bytes = 0;
        let plan = frame.scene.layers.get_mut(&999).ok_or("layer")?;
        plan.operations = [
            132.0_f32, 0.2, 0.5, 1.0, 0.7, 12.0, 0.1, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
        ]
        .into_iter()
        .flat_map(f32::to_le_bytes)
        .collect();
        plan.uniforms[64..68].copy_from_slice(&1_f32.to_le_bytes());
        renderer.options.effect_regions = false;
        let full = LayerFixture::pixels(renderer, &frame, &registry)?;
        renderer.options.effect_regions = true;
        let rendered = renderer.render(&frame, &registry)?;
        assert_eq!(rendered.effect_regions.bounded_passes, 1);
        assert!(rendered.effect_regions.drawn_pixels < rendered.effect_regions.full_pixels / 2);
        assert_eq!(renderer.read_rgba(&rendered)?, full);
        drop(rendered);
        // The outer glow must survive beyond the original quad, including fractional Y edges.
        assert!(
            full.chunks_exact(4)
                .enumerate()
                .any(|(index, pixel)| pixel[3] > 0 && (index % 320 < 120 || index % 320 >= 200))
        );
        frame.scene.layers.get_mut(&999).ok_or("layer")?.operations[..4]
            .copy_from_slice(&134_f32.to_le_bytes());
        renderer.options.effect_regions = false;
        let stroke = LayerFixture::pixels(renderer, &frame, &registry)?;
        assert_ne!(stroke, full);
        renderer.options.effect_regions = true;
        assert_eq!(LayerFixture::pixels(renderer, &frame, &registry)?, stroke);
        for vertex in frame.scene.vertices.chunks_exact_mut(160) {
            let x = f32::from_le_bytes(vertex[..4].try_into()?) + 4.0;
            vertex[..4].copy_from_slice(&x.to_le_bytes());
        }
        let rendered = renderer.render(&frame, &registry)?;
        assert_eq!(rendered.effect_regions.drawn_pixels, 0);
        let empty = renderer.read_rgba(&rendered)?;
        drop(rendered);
        assert!(empty.chunks_exact(4).all(|pixel| pixel[3] == 0));
        renderer.options.effect_regions = false;
        assert_eq!(LayerFixture::pixels(renderer, &frame, &registry)?, empty);
        Ok(())
    }
}

#[test]
fn effect_regions_pad_projected_bounds_and_reject_unproved_programs()
-> Result<(), Box<dyn std::error::Error>> {
    let (mut frame, _) = RegionFixture::frame()?;
    let regions = EffectRegions {
        enabled: true,
        statistics: Default::default(),
    };
    assert_eq!(
        regions.collect(&frame.scene)?.get(&2),
        Some(&PixelRegion {
            x: 118,
            y: 65,
            width: 84,
            height: 50,
        })
    );
    let plan = frame.scene.layers.get_mut(&999).ok_or("layer")?;
    plan.operations = [
        134.0_f32, 0.2, 0.5, 1.0, 0.7, 6.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ]
    .into_iter()
    .flat_map(f32::to_le_bytes)
    .collect();
    plan.uniforms[64..68].copy_from_slice(&1_f32.to_le_bytes());
    assert_eq!(
        regions.collect(&frame.scene)?.get(&2),
        Some(&PixelRegion {
            x: 112,
            y: 59,
            width: 96,
            height: 62,
        })
    );
    frame.scene.layers.get_mut(&999).ok_or("layer")?.operations[..4]
        .copy_from_slice(&1_f32.to_le_bytes());
    assert!(regions.collect(&frame.scene)?.is_empty());
    frame
        .scene
        .layers
        .get_mut(&999)
        .ok_or("layer")?
        .operations
        .clear();
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[52..56]
        .copy_from_slice(&0.1_f32.to_le_bytes());
    assert!(regions.collect(&frame.scene)?.is_empty());
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[52..56].fill(0);
    frame.scene.vertices[..4].copy_from_slice(&f32::INFINITY.to_le_bytes());
    assert!(regions.collect(&frame.scene)?.is_empty());
    Ok(())
}

use super::{NativeOptions, NativeRenderer};
use crate::{SuppliedFrame, layer_key::LayerKey, layer_plan::LayerPlan};
use aster_render_ir::{
    BufferResourceDescriptor, DecodeLimits, EffectComposite, ElementType, FplnCodec, PutResource,
    ResourceDescriptor, ResourceHash, ResourceKind, ResourceRegistry, RootCommandRecord,
    RootTextureReference,
};
use std::{collections::BTreeMap, time::Duration};

struct LayerFixture;

impl LayerFixture {
    fn frame() -> Result<(SuppliedFrame, ResourceRegistry), Box<dyn std::error::Error>> {
        let base = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/parity/native-surface-frame");
        let limits = DecodeLimits::default();
        let plan = FplnCodec::decode(
            std::fs::read(base.join("selectionIsolation-off-ready/plan.fpln"))?,
            &limits,
        )?;
        let mut registry = ResourceRegistry::new(Default::default())?;
        for hash in &plan.metadata.resources {
            let bytes = std::fs::read(base.join(format!("resources/{}.bin", hash.0)))?;
            registry.put(
                PutResource {
                    hash: hash.clone(),
                    kind: ResourceKind::Buffer,
                    descriptor: ResourceDescriptor::Buffer(BufferResourceDescriptor {
                        element_type: ElementType::U8,
                        element_count: bytes.len() as u32,
                        byte_length: bytes.len() as u32,
                    }),
                },
                bytes,
            )?;
        }
        let mut frame = SuppliedFrame::new(plan, &registry, &limits, &[])?;
        frame.surface = None;
        let draws = frame
            .scene
            .root
            .commands
            .iter()
            .filter(|command| matches!(command, RootCommandRecord::Geometry { .. }))
            .cloned()
            .collect::<Vec<_>>();
        let begin = frame
            .scene
            .root
            .commands
            .first()
            .ok_or("empty scene")?
            .clone();
        frame.scene.root.commands = vec![
            begin,
            RootCommandRecord::EndScene,
            RootCommandRecord::BeginLayer {
                effect_blob_index: 999,
            },
        ];
        frame.scene.root.commands.extend(draws);
        frame
            .scene
            .root
            .commands
            .push(RootCommandRecord::FinishLayer);
        let mut uniforms = frame.post.clone();
        uniforms[64..68].copy_from_slice(&0_f32.to_le_bytes());
        frame.scene.layers = BTreeMap::from([(
            999,
            LayerPlan {
                blend: 0,
                lut: None,
                uniforms,
                operations: vec![],
                composite: EffectComposite::Fixed,
                pyramids: Default::default(),
                glow_threshold: 1.0,
            },
        )]);
        Ok((frame, registry))
    }

    fn key(frame: &SuppliedFrame) -> Result<ResourceHash, Box<dyn std::error::Error>> {
        Ok(LayerKey::collect(&frame.scene, &BTreeMap::new())?
            .remove(&2)
            .ok_or("key absent")?
            .hash)
    }

    fn pixels(
        renderer: &mut NativeRenderer,
        frame: &SuppliedFrame,
        registry: &ResourceRegistry,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let output = renderer.render(frame, registry)?;
        Ok(renderer.read_rgba(&output)?)
    }
}

#[test]
fn layer_keys_track_evaluated_inputs_and_conservative_time_dependencies()
-> Result<(), Box<dyn std::error::Error>> {
    let (mut frame, _) = LayerFixture::frame()?;
    let initial = LayerFixture::key(&frame)?;
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[8..12]
        .copy_from_slice(&2_f32.to_le_bytes());
    assert_eq!(LayerFixture::key(&frame)?, initial);
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[52..56]
        .copy_from_slice(&0.2_f32.to_le_bytes());
    let grain = LayerFixture::key(&frame)?;
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[8..12]
        .copy_from_slice(&3_f32.to_le_bytes());
    assert_ne!(LayerFixture::key(&frame)?, grain);
    for code in [4_f32, 7_f32, 268_f32] {
        let plan = frame.scene.layers.get_mut(&999).ok_or("layer")?;
        plan.uniforms[52..56].fill(0);
        plan.operations = vec![0; 64];
        plan.operations[..4].copy_from_slice(&code.to_le_bytes());
        plan.uniforms[8..12].copy_from_slice(&1_f32.to_le_bytes());
        let before = LayerFixture::key(&frame)?;
        frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[8..12]
            .copy_from_slice(&4_f32.to_le_bytes());
        assert_eq!(LayerFixture::key(&frame)? == before, code != 7.0);
    }
    let before = LayerFixture::key(&frame)?;
    frame.scene.lighting[0] ^= 1;
    assert_ne!(LayerFixture::key(&frame)?, before);
    let before = LayerFixture::key(&frame)?;
    frame.scene.vertices[0] ^= 1;
    assert_ne!(LayerFixture::key(&frame)?, before);
    let before = LayerFixture::key(&frame)?;
    frame.scene.layers.get_mut(&999).ok_or("layer")?.lut = Some(ResourceHash("a".repeat(64)));
    assert_ne!(LayerFixture::key(&frame)?, before);
    let draw = frame.scene.root.draws.first_mut().ok_or("draw")?;
    let hash = ResourceHash("b".repeat(64));
    draw.texture = RootTextureReference::Media { hash: hash.clone() };
    frame.scene.images.insert(
        hash.clone(),
        crate::image_input::ImageInput {
            frame: hash.clone(),
            pixels: ResourceHash("c".repeat(64)),
            width: 1,
            height: 1,
            format: aster_render_ir::MediaTextureFormat::Rgba8UnormSrgb,
        },
    );
    let before = LayerFixture::key(&frame)?;
    frame.scene.images.get_mut(&hash).ok_or("image")?.pixels = ResourceHash("d".repeat(64));
    assert_ne!(LayerFixture::key(&frame)?, before);
    frame.scene.root.draws.first_mut().ok_or("draw")?.texture = RootTextureReference::Surface {
        instance_id: frame.scene.header.composition_id.clone(),
    };
    assert!(LayerKey::collect(&frame.scene, &BTreeMap::new())?.is_empty());
    Ok(())
}

#[test]
#[ignore = "requires GPU"]
fn native_layer_cache_reuses_invalidates_and_falls_back_without_pixel_changes()
-> Result<(), Box<dyn std::error::Error>> {
    let (mut frame, registry) = LayerFixture::frame()?;
    let plan = frame.scene.layers.get_mut(&999).ok_or("layer")?;
    plan.operations = [
        4.0_f32, 0.5, 0.8, 0.9, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ]
    .into_iter()
    .flat_map(f32::to_le_bytes)
    .collect();
    plan.uniforms[64..68].copy_from_slice(&1_f32.to_le_bytes());
    let mut renderer = NativeRenderer::new(NativeOptions {
        effect_regions: true,
        dxcompiler: cfg!(target_os = "windows").then(|| {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../node_modules/electron/dist/dxcompiler.dll")
        }),
        adapter_name: None,
        gpu_budget_bytes: 16 * 1024 * 1024,
        layer_cache_bytes: 4 * 1024 * 1024,
        timeout: Duration::from_secs(30),
        backend: if cfg!(target_os = "windows") {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
    })?;
    let first = LayerFixture::pixels(&mut renderer, &frame, &registry)?;
    assert_eq!(renderer.layer_cache.statistics.stores, 1);
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[8..12]
        .copy_from_slice(&5_f32.to_le_bytes());
    assert_eq!(
        LayerFixture::pixels(&mut renderer, &frame, &registry)?,
        first
    );
    assert_eq!(renderer.layer_cache.statistics.hits, 1);
    // The cached layer still composites against the current backdrop.
    frame.scene.clears[0] = [0.4, 0.1, 0.2, 1.0, 1.0];
    let changed_backdrop = LayerFixture::pixels(&mut renderer, &frame, &registry)?;
    assert_ne!(changed_backdrop, first);
    assert_eq!(renderer.layer_cache.statistics.hits, 2);
    renderer.options.layer_cache_bytes = 0;
    assert_eq!(
        LayerFixture::pixels(&mut renderer, &frame, &registry)?,
        changed_backdrop
    );
    assert_eq!(renderer.layer_cache.statistics.resident_bytes, 0);
    renderer.options.layer_cache_bytes = 4 * 1024 * 1024;
    LayerFixture::pixels(&mut renderer, &frame, &registry)?;
    let stores = renderer.layer_cache.statistics.stores;
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[12..16]
        .copy_from_slice(&2_f32.to_le_bytes());
    let changed_effect = LayerFixture::pixels(&mut renderer, &frame, &registry)?;
    assert_ne!(changed_effect, changed_backdrop);
    assert_eq!(renderer.layer_cache.statistics.stores, stores + 1);
    let retained = renderer.layer_cache.statistics;
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[12..16]
        .copy_from_slice(&frame.post[12..16]);
    assert_eq!(
        LayerFixture::pixels(&mut renderer, &frame, &registry)?,
        changed_backdrop
    );
    assert_eq!(
        renderer.layer_cache.statistics.allocations,
        retained.allocations
    );
    assert_eq!(
        renderer.layer_cache.statistics.evictions,
        retained.evictions
    );
    assert_eq!(renderer.layer_cache.statistics.stores, retained.stores);
    frame.scene.layers.get_mut(&999).ok_or("layer")?.uniforms[12..16]
        .copy_from_slice(&2_f32.to_le_bytes());
    renderer.options.layer_cache_bytes = 1;
    assert_eq!(
        LayerFixture::pixels(&mut renderer, &frame, &registry)?,
        changed_effect
    );
    assert_eq!(renderer.layer_cache.statistics.resident_bytes, 0);
    renderer.options.layer_cache_bytes = 4 * 1024 * 1024;
    let size = frame.scene.header.render_target;
    let output = frame.scene.header.target;
    renderer.options.gpu_budget_bytes = u64::from(size.width) * u64::from(size.height) * 16
        + u64::from(output.width) * u64::from(output.height) * 4
        + frame.scene.transient_bytes();
    assert_eq!(
        LayerFixture::pixels(&mut renderer, &frame, &registry)?,
        changed_effect
    );
    assert_eq!(renderer.layer_cache.statistics.resident_bytes, 0);
    let before = renderer.layer_cache.statistics;
    renderer.options.gpu_budget_bytes -= 1;
    assert!(renderer.render(&frame, &registry).is_err());
    assert_eq!(renderer.layer_cache.statistics, before);
    renderer.options.gpu_budget_bytes = 16 * 1024 * 1024;
    // A recorded copy in an abandoned encoder is never a valid cache generation.
    renderer.layer_cache.prepare(
        &renderer.device,
        &[&frame.scene],
        BTreeMap::new(),
        4 * 1024 * 1024,
        renderer.options.timeout,
    )?;
    renderer.layer_cache.allocate(&renderer.device);
    let key = LayerFixture::key(&frame)?;
    let mut abandoned = renderer.device.create_command_encoder(&Default::default());
    let source = renderer.targets.as_ref().ok_or("targets")?.scene.raw();
    renderer.layer_cache.store(&key, &mut abandoned, source);
    drop(abandoned);
    renderer.layer_cache.prepare(
        &renderer.device,
        &[&frame.scene],
        BTreeMap::new(),
        4 * 1024 * 1024,
        renderer.options.timeout,
    )?;
    let mut probe = renderer.device.create_command_encoder(&Default::default());
    assert!(!renderer.layer_cache.restore(&key, &mut probe, source));
    drop(probe);
    assert_eq!(
        LayerFixture::pixels(&mut renderer, &frame, &registry)?,
        changed_effect
    );
    surface_generation_tests::RecursiveFixture::verify_gpu(&mut renderer)?;
    effect_region_tests::RegionFixture::verify_gpu(&mut renderer)?;
    Ok(())
}

#[path = "surface_generation_tests.rs"]
mod surface_generation_tests;

#[path = "effect_region_tests.rs"]
mod effect_region_tests;

#[path = "ssaa_effect_tests.rs"]
mod ssaa_effect_tests;

#[test]
fn shadow_occluders_outside_cached_draws_invalidate_layer_keys()
-> Result<(), Box<dyn std::error::Error>> {
    let (mut frame, _) = LayerFixture::frame()?;
    let initial = LayerFixture::key(&frame)?;
    let first = frame.scene.vertices.len() as u32 / 160;
    frame.scene.vertices.extend_from_slice(&[0; 480]);
    assert_eq!(LayerFixture::key(&frame)?, initial);
    frame.scene.shadow_size = 512;
    frame.scene.shadow_draws.push(first..first + 3);
    let shadow = LayerFixture::key(&frame)?;
    assert_ne!(shadow, initial);
    let offset = first as usize * 160 + 68;
    frame.scene.vertices[offset..offset + 4].copy_from_slice(&1_f32.to_le_bytes());
    assert_ne!(LayerFixture::key(&frame)?, shadow);
    Ok(())
}

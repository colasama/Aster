use std::collections::BTreeMap;

use aster_render_ir::{
    BufferResourceDescriptor, ElementType, PutResource, ResourceDescriptor, ResourceHash,
    ResourceKind, ResourceLimits, ResourceRegistry,
};

use super::{NativeOptions, NativeRenderer};
use crate::{ImageCacheStatistics, image_input::ImageInput};

struct ImageFixture;

impl ImageFixture {
    fn input(
        registry: &mut ResourceRegistry,
        frame: char,
        rgba: [u8; 4],
    ) -> Result<ImageInput, Box<dyn std::error::Error>> {
        let bytes = rgba.repeat(4);
        let descriptor = BufferResourceDescriptor {
            element_type: ElementType::U8,
            element_count: 16,
            byte_length: 16,
        };
        let pixels = ResourceHash::for_buffer(&descriptor, &bytes)?;
        registry.put(
            PutResource {
                hash: pixels.clone(),
                kind: ResourceKind::Buffer,
                descriptor: ResourceDescriptor::Buffer(descriptor),
            },
            bytes,
        )?;
        Ok(ImageInput {
            frame: ResourceHash(frame.to_string().repeat(64)),
            pixels,
            width: 2,
            height: 2,
            format: aster_render_ir::MediaTextureFormat::Rgba8UnormSrgb,
        })
    }
}

#[test]
#[ignore = "requires GPU"]
fn native_image_cache_reuses_generations_and_admits_atomically()
-> Result<(), Box<dyn std::error::Error>> {
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: if cfg!(target_os = "windows") {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
        adapter_name: None,
        gpu_budget_bytes: 1024 * 1024,
        timeout: std::time::Duration::from_secs(30),
    })?;
    let gpu = (&renderer.device, &renderer.queue);
    let timeout = renderer.options.timeout;
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    let red = ImageFixture::input(&mut registry, 'a', [255, 0, 0, 255])?;
    let green = ImageFixture::input(&mut registry, 'b', [0, 255, 0, 255])?;
    let blue = ImageFixture::input(&mut registry, 'a', [0, 0, 255, 255])?;
    let initial = BTreeMap::from([
        (red.frame.clone(), red.clone()),
        (green.frame.clone(), green.clone()),
    ]);
    assert!(
        renderer
            .images
            .prepare(gpu, &initial, &registry, 31, timeout)
            .is_err()
    );
    assert_eq!(renderer.images.statistics, ImageCacheStatistics::default());
    renderer
        .images
        .prepare(gpu, &initial, &registry, 32, timeout)?;
    let original = renderer.images.binding(&red)?.clone();
    renderer.images.prepare(
        gpu,
        &BTreeMap::from([(red.frame.clone(), red.clone())]),
        &registry,
        32,
        timeout,
    )?;
    assert_eq!(renderer.images.binding(&red)?, &original);
    assert_eq!(renderer.images.statistics.uploads, 2);
    assert_eq!(renderer.images.statistics.hits, 1);
    drop(original);
    // A new pixel generation for the same frame must not reuse the old GPU binding.
    let changed = BTreeMap::from([
        (blue.frame.clone(), blue.clone()),
        (green.frame.clone(), green.clone()),
    ]);
    renderer.queue.submit([]);
    renderer
        .images
        .prepare(gpu, &changed, &registry, 32, timeout)?;
    assert!(renderer.images.binding(&red).is_err());
    assert!(renderer.images.binding(&blue).is_ok());
    assert!(renderer.images.binding(&green).is_ok());
    assert_eq!(
        renderer.images.statistics,
        ImageCacheStatistics {
            uploads: 3,
            hits: 2,
            evictions: 1,
            resident_bytes: 32
        }
    );
    let before = renderer.images.statistics;
    assert!(
        renderer
            .images
            .prepare(gpu, &initial, &registry, 31, timeout)
            .is_err()
    );
    assert_eq!(renderer.images.statistics, before);
    let missing = ResourceRegistry::new(ResourceLimits::default())?;
    assert!(
        renderer
            .images
            .prepare(gpu, &changed, &missing, 32, timeout)
            .is_err()
    );
    assert_eq!(renderer.images.statistics, before);
    renderer.images.prepare(
        gpu,
        &BTreeMap::from([(blue.frame.clone(), blue)]),
        &registry,
        16,
        timeout,
    )?;
    assert_eq!(renderer.images.statistics.resident_bytes, 16);
    renderer
        .images
        .prepare(gpu, &BTreeMap::new(), &registry, 0, timeout)?;
    assert_eq!(renderer.images.statistics.resident_bytes, 0);
    Ok(())
}

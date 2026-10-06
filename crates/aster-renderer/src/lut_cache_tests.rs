use std::{collections::BTreeMap, sync::mpsc, time::Duration};

use aster_render_ir::{
    PutResource, ResourceDescriptor, ResourceHash, ResourceKind, ResourceLimits, ResourceRegistry,
    TextureDimension, TexturePixelFormat, TexturePixelsDescriptor,
};

use super::{LutCache, LutInput};

struct LutFixture;
impl LutFixture {
    fn put(
        registry: &mut ResourceRegistry,
        descriptor: TexturePixelsDescriptor,
        bytes: Vec<u8>,
    ) -> Result<ResourceHash, Box<dyn std::error::Error>> {
        let descriptor = ResourceDescriptor::TexturePixels(descriptor);
        let hash = ResourceHash::for_resource(ResourceKind::TexturePixels, &descriptor, &bytes)?;
        registry.put(
            PutResource {
                hash: hash.clone(),
                kind: ResourceKind::TexturePixels,
                descriptor,
            },
            bytes,
        )?;
        Ok(hash)
    }

    fn read(
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("LUT test readback"),
            size: 1024,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(256),
                    rows_per_image: Some(2),
                },
            },
            texture.size(),
        );
        let submission = queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::sync_channel(1);
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        device.poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(Duration::from_secs(30)),
        })?;
        receiver.recv_timeout(Duration::from_secs(30))??;
        let mut result = Vec::new();
        {
            let mapped = buffer.slice(..).get_mapped_range()?;
            for row in mapped.chunks_exact(256) {
                result.extend_from_slice(&row[..16]);
            }
        }
        buffer.unmap();
        Ok(result)
    }
}

#[test]
fn lut_input_rejects_wrong_shapes_and_non_finite_samples() -> Result<(), Box<dyn std::error::Error>>
{
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    let descriptor = TexturePixelsDescriptor {
        dimension: TextureDimension::D3,
        width: 2,
        height: 2,
        depth: 2,
        format: TexturePixelFormat::Rgba16Float,
    };
    for (shape, bytes) in [
        (
            TexturePixelsDescriptor {
                dimension: TextureDimension::D2,
                depth: 1,
                ..descriptor.clone()
            },
            vec![0; 32],
        ),
        (
            TexturePixelsDescriptor {
                width: 1,
                ..descriptor.clone()
            },
            vec![0; 32],
        ),
        (
            descriptor.clone(),
            [0_u16, 0x7c00, 0, 0x3c00]
                .iter()
                .flat_map(|x| x.to_le_bytes())
                .collect::<Vec<_>>()
                .repeat(8),
        ),
    ] {
        let hash = LutFixture::put(&mut registry, shape, bytes)?;
        assert!(LutInput::new(&hash, &registry).is_err());
    }
    Ok(())
}

#[test]
#[ignore = "requires GPU"]
fn native_lut_cache_preserves_half_floats_reuses_and_admits_atomically()
-> Result<(), Box<dyn std::error::Error>> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
        ..Default::default()
    }))?;
    assert_ne!(adapter.get_info().device_type, wgpu::DeviceType::Cpu);
    let (device, queue) =
        pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))?;
    let (device, queue) = (&device, &queue);
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    let descriptor = TexturePixelsDescriptor {
        dimension: TextureDimension::D3,
        width: 2,
        height: 2,
        depth: 2,
        format: TexturePixelFormat::Rgba16Float,
    };
    let bytes = [0x4400_u16, 0xc000, 0x3400, 0x3800]
        .iter()
        .flat_map(|x| x.to_le_bytes())
        .collect::<Vec<_>>()
        .repeat(8);
    let first = LutFixture::put(&mut registry, descriptor.clone(), bytes.clone())?;
    let second = LutFixture::put(&mut registry, descriptor, vec![0; 64])?;
    let mut inputs = BTreeMap::from([(first.clone(), LutInput::new(&first, &registry)?)]);
    let mut cache = LutCache::default();
    let timeout = Duration::from_secs(30);
    assert!(
        cache
            .prepare((device, queue), &inputs, &registry, 63, timeout)
            .is_err()
    );
    assert_eq!(cache.statistics, Default::default());
    cache.prepare((device, queue), &inputs, &registry, 64, timeout)?;
    assert_eq!(cache.statistics.uploads, 1);
    assert_eq!(
        LutFixture::read(device, queue, &cache.entries[&first]._texture)?,
        bytes
    );
    cache.prepare((device, queue), &inputs, &registry, 64, timeout)?;
    assert_eq!(cache.statistics.hits, 1);
    assert_eq!(cache.statistics.uploads, 1);
    inputs.insert(second.clone(), LutInput::new(&second, &registry)?);
    let before = cache.statistics;
    assert!(
        cache
            .prepare((device, queue), &inputs, &registry, 127, timeout)
            .is_err()
    );
    assert_eq!(cache.statistics, before);
    assert!(cache.view(&first).is_ok());
    cache.prepare((device, queue), &inputs, &registry, 128, timeout)?;
    assert_eq!(cache.statistics.resident_bytes, 128);
    assert_eq!(
        LutFixture::read(device, queue, &cache.entries[&second]._texture)?,
        vec![0; 64]
    );
    inputs.remove(&first);
    cache.prepare((device, queue), &inputs, &registry, 64, timeout)?;
    assert!(cache.view(&first).is_err());
    assert!(cache.view(&second).is_ok());
    assert_eq!(cache.statistics.evictions, 1);
    inputs.clear();
    cache.prepare((device, queue), &inputs, &registry, 0, timeout)?;
    assert_eq!(cache.statistics.resident_bytes, 0);
    assert_eq!(cache.statistics.evictions, 2);
    Ok(())
}

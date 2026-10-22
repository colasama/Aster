use crate::{
    NativeOptions, NativeRenderer,
    generator_storage::{GeneratorStorage, GeneratorStoragePool},
};
use aster_render::NativeBackend;
use std::time::Duration;

struct StorageWitness;
impl StorageWitness {
    fn read(
        renderer: &NativeRenderer,
        storage: &GeneratorStorage,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let readback = renderer.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Generator storage witness"),
            size: storage.buffer.size(),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = renderer.device.create_command_encoder(&Default::default());
        storage.initialize(&mut encoder, false);
        encoder.copy_buffer_to_buffer(&storage.buffer, 0, &readback, 0, storage.buffer.size());
        renderer.queue.submit([encoder.finish()]);
        let (send, receive) = std::sync::mpsc::channel();
        readback.map_async(wgpu::MapMode::Read, .., move |result| {
            let _ = send.send(result);
        });
        renderer.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        receive.recv_timeout(Duration::from_secs(30))??;
        let bytes = readback.get_mapped_range(..)?.to_vec();
        readback.unmap();
        Ok(bytes)
    }
}

#[test]
#[ignore = "requires GPU"]
fn recycled_generator_storage_is_zeroed_once_per_frame_and_budgeted()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let renderer = NativeRenderer::new(NativeOptions {
        backend: NativeBackend::Dx12,
        adapter_name: None,
        dxcompiler: Some(root.join("node_modules/electron/dist/dxcompiler.dll")),
        gpu_budget_bytes: 64 * 1024 * 1024,
        layer_cache_bytes: 0,
        effect_regions: true,
        effect_pipeline_entries: 16,
        gpu_timestamps: false,
        timeout: Duration::from_secs(30),
    })?;
    let mut storage = GeneratorStorage::new(&renderer.device, 64, None);
    let larger = GeneratorStorage::new(&renderer.device, 128, None);
    let mut pool = GeneratorStoragePool::default();
    for marker in [0x79, 0xe3] {
        renderer
            .queue
            .write_buffer(&storage.buffer, 0, &[marker; 64]);
        renderer.device.poll(wgpu::PollType::Wait {
            submission_index: None,
            timeout: Some(Duration::from_secs(30)),
        })?;
        pool.recycle([storage.buffer, larger.buffer.clone()].into_iter(), 256);
        assert_eq!(pool.bytes, 192);
        let recycled = pool
            .take(64, 0)
            .ok_or("same-size allocation was not recycled")?;
        assert_eq!(pool.bytes, 0);
        assert!(pool.take(128, 256).is_none());
        storage = GeneratorStorage::new(&renderer.device, 64, Some(recycled));
        assert_eq!(StorageWitness::read(&renderer, &storage)?, [0; 64]);
        renderer
            .queue
            .write_buffer(&storage.buffer, 0, &[marker; 64]);
        // An auxiliary use in this generation must preserve the compute output.
        assert_eq!(
            StorageWitness::read(&renderer, &storage.clone())?,
            [marker; 64]
        );
    }
    pool.recycle([storage.buffer, larger.buffer].into_iter(), 63);
    assert_eq!(pool.bytes, 0);
    Ok(())
}

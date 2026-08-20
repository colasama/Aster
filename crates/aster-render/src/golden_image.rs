use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

use crate::NativeBackend;

const WIDTH: u32 = 37;
const HEIGHT: u32 = 23;
const BYTES_PER_PIXEL: u32 = 4;
const GPU_TIMEOUT: Duration = Duration::from_secs(30);

const GOLDEN_SHADER: &str = r#"
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> @builtin(position) vec4<f32> {
    let positions = array(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0),
    );
    return vec4<f32>(positions[vertex_index], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let pixel = vec2<u32>(position.xy);
    let red = select(0.0, 1.0, (pixel.x & 1u) != 0u);
    let green = select(0.0, 1.0, (pixel.y & 1u) != 0u);
    let blue = select(0.0, 1.0, ((pixel.x ^ pixel.y) & 1u) != 0u);
    return vec4<f32>(red, green, blue, 1.0);
}
"#;

#[derive(Debug)]
struct GoldenFrame {
    adapter_name: String,
    backend: wgpu::Backend,
    pixels: Vec<u8>,
}

fn backend_flags(backend: NativeBackend) -> wgpu::Backends {
    match backend {
        NativeBackend::Vulkan => wgpu::Backends::VULKAN,
        NativeBackend::Metal => wgpu::Backends::METAL,
        NativeBackend::Dx12 => wgpu::Backends::DX12,
    }
}

fn backend_kind(backend: NativeBackend) -> wgpu::Backend {
    match backend {
        NativeBackend::Vulkan => wgpu::Backend::Vulkan,
        NativeBackend::Metal => wgpu::Backend::Metal,
        NativeBackend::Dx12 => wgpu::Backend::Dx12,
    }
}

fn expected_pixels() -> Vec<u8> {
    let mut pixels = Vec::with_capacity((WIDTH * HEIGHT * BYTES_PER_PIXEL) as usize);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            pixels.extend_from_slice(&[
                if x & 1 == 0 { 0 } else { 255 },
                if y & 1 == 0 { 0 } else { 255 },
                if (x ^ y) & 1 == 0 { 0 } else { 255 },
                255,
            ]);
        }
    }
    pixels
}

fn render_golden(backend: NativeBackend) -> Result<GoldenFrame, String> {
    let flags = backend_flags(backend);
    if !wgpu::Instance::enabled_backend_features().contains(flags) {
        return Err(format!("{backend:?} is not compiled into this wgpu build"));
    }

    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: flags,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    });
    let expected_backend = backend_kind(backend);
    let adapters = pollster::block_on(instance.enumerate_adapters(flags));
    let adapter = adapters
        .into_iter()
        .filter(|candidate| candidate.get_info().backend == expected_backend)
        .max_by_key(|candidate| adapter_priority(candidate.get_info().device_type))
        .ok_or_else(|| format!("{backend:?} exposed no compatible native adapter"))?;
    let adapter_info = adapter.get_info();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("Aster golden-image device"),
        ..Default::default()
    }))
    .map_err(|error| {
        format!(
            "requesting a {backend:?} device from '{}' failed: {error}",
            adapter_info.name
        )
    })?;

    let validation_scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Aster golden-image RGBA target"),
        size: wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("Aster deterministic golden-image shader"),
        source: wgpu::ShaderSource::Wgsl(GOLDEN_SHADER.into()),
    });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("Aster deterministic golden-image pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format: wgpu::TextureFormat::Rgba8Unorm,
                blend: None,
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    });

    let unpadded_bytes_per_row = WIDTH * BYTES_PER_PIXEL;
    let padded_bytes_per_row = unpadded_bytes_per_row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT)
        * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let readback = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("Aster golden-image readback"),
        size: u64::from(padded_bytes_per_row * HEIGHT),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("Aster golden-image encoder"),
    });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Aster golden-image render pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&pipeline);
        pass.draw(0..3, 0..1);
    }
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo {
            texture: &texture,
            mip_level: 0,
            origin: wgpu::Origin3d::ZERO,
            aspect: wgpu::TextureAspect::All,
        },
        wgpu::TexelCopyBufferInfo {
            buffer: &readback,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(padded_bytes_per_row),
                rows_per_image: Some(HEIGHT),
            },
        },
        wgpu::Extent3d {
            width: WIDTH,
            height: HEIGHT,
            depth_or_array_layers: 1,
        },
    );

    let submission = queue.submit([encoder.finish()]);
    let slice = readback.slice(..);
    let (mapping_tx, mapping_rx) = mpsc::sync_channel(1);
    slice.map_async(wgpu::MapMode::Read, move |result| {
        let _ = mapping_tx.send(result);
    });
    let started = Instant::now();
    device
        .poll(wgpu::PollType::Wait {
            submission_index: Some(submission),
            timeout: Some(GPU_TIMEOUT),
        })
        .map_err(|error| {
            format!(
                "{backend:?} submission on '{}' did not complete within {GPU_TIMEOUT:?}: {error:?}",
                adapter_info.name
            )
        })?;
    let remaining = GPU_TIMEOUT.saturating_sub(started.elapsed());
    mapping_rx
        .recv_timeout(remaining)
        .map_err(|error| {
            format!(
                "{backend:?} readback callback on '{}' timed out after {GPU_TIMEOUT:?}: {error}",
                adapter_info.name
            )
        })?
        .map_err(|error| {
            format!(
                "mapping {backend:?} readback from '{}' failed: {error}",
                adapter_info.name
            )
        })?;

    let mapped = match slice.get_mapped_range() {
        Ok(mapped) => mapped,
        Err(error) => {
            readback.unmap();
            return Err(format!(
                "reading mapped {backend:?} bytes from '{}' failed: {error}",
                adapter_info.name
            ));
        }
    };
    let mut pixels = Vec::with_capacity((unpadded_bytes_per_row * HEIGHT) as usize);
    for row in mapped.chunks_exact(padded_bytes_per_row as usize) {
        pixels.extend_from_slice(&row[..unpadded_bytes_per_row as usize]);
    }
    drop(mapped);
    readback.unmap();

    let internal_error = pollster::block_on(internal_scope.pop());
    let validation_error = pollster::block_on(validation_scope.pop());
    if let Some(error) = internal_error.or(validation_error) {
        return Err(format!(
            "{backend:?} validation on '{}' failed: {error}",
            adapter_info.name
        ));
    }

    drop(readback);
    drop(pipeline);
    drop(shader);
    drop(view);
    drop(texture);
    device
        .poll(wgpu::PollType::Poll)
        .map_err(|error| format!("final {backend:?} resource poll failed: {error:?}"))?;

    Ok(GoldenFrame {
        adapter_name: adapter_info.name,
        backend: adapter_info.backend,
        pixels,
    })
}

fn adapter_priority(device_type: wgpu::DeviceType) -> u8 {
    match device_type {
        wgpu::DeviceType::DiscreteGpu => 4,
        wgpu::DeviceType::IntegratedGpu => 3,
        wgpu::DeviceType::VirtualGpu => 2,
        wgpu::DeviceType::Cpu => 1,
        wgpu::DeviceType::Other => 0,
    }
}

fn assert_backend_matches_golden(backend: NativeBackend) -> GoldenFrame {
    let frame = render_golden(backend)
        .unwrap_or_else(|error| panic!("{backend:?} golden-image render failed: {error}"));
    assert_eq!(frame.backend, backend_kind(backend));
    assert_eq!(
        frame.pixels,
        expected_pixels(),
        "{backend:?} output from '{}' differed from the CPU golden image",
        frame.adapter_name
    );
    println!(
        "{backend:?} golden image matched {} bytes on '{}'",
        frame.pixels.len(),
        frame.adapter_name
    );
    frame
}

#[test]
fn cpu_golden_fixture_has_exact_dimensions_and_pattern() {
    let pixels = expected_pixels();
    assert_eq!(pixels.len(), (WIDTH * HEIGHT * BYTES_PER_PIXEL) as usize);
    assert_eq!(&pixels[0..4], &[0, 0, 0, 255]);
    assert_eq!(&pixels[4..8], &[255, 0, 255, 255]);
    let second_row = (WIDTH * BYTES_PER_PIXEL) as usize;
    assert_eq!(&pixels[second_row..second_row + 4], &[0, 255, 255, 255]);
    assert_eq!(
        &pixels[pixels.len() - 4..],
        &[0, 0, 0, 255],
        "the odd dimensions must retain the final boundary pixel"
    );
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires a native DX12 adapter"]
fn windows_dx12_golden_image_matches_cpu_fixture() {
    assert_backend_matches_golden(NativeBackend::Dx12);
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires a native Vulkan adapter"]
fn windows_vulkan_golden_image_matches_cpu_fixture() {
    assert_backend_matches_golden(NativeBackend::Vulkan);
}

#[cfg(target_os = "windows")]
#[test]
#[ignore = "requires native DX12 and Vulkan adapters"]
fn windows_dx12_and_vulkan_golden_images_are_identical() {
    let dx12 = assert_backend_matches_golden(NativeBackend::Dx12);
    let vulkan = assert_backend_matches_golden(NativeBackend::Vulkan);
    assert_eq!(
        dx12.pixels, vulkan.pixels,
        "DX12 '{}' and Vulkan '{}' produced different RGBA8 frames",
        dx12.adapter_name, vulkan.adapter_name
    );
}

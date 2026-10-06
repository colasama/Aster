use super::{NativeOptions, NativeRenderer};
use crate::{geometry_pipelines::GeometryPipelines, image_input::ImageInput};
use aster_media_native::{NativeStillDecoder, StillAuthorization, StillLimits};
use aster_render_ir::{
    BufferResourceDescriptor, CompositionIdentity, ElementType, MediaFrameDescriptor, MediaKind,
    MediaSample, MediaSourceDescriptor, MediaTextureFormat, PutResource, ResourceDescriptor,
    ResourceHash, ResourceKind, ResourceLimits, ResourceRegistry,
};
use exr::prelude::{Image, SpecificChannels, WritableImage, f16};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Cursor, path::PathBuf, sync::mpsc, time::Duration};
use wgpu::util::DeviceExt;

struct HdrFixture {
    path: PathBuf,
}
impl Drop for HdrFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
impl HdrFixture {
    fn input(
        &self,
        registry: &mut ResourceRegistry,
    ) -> Result<ImageInput, Box<dyn std::error::Error>> {
        let mut encoded = Cursor::new(Vec::new());
        Image::from_channels(
            (2, 1),
            SpecificChannels::rgba(|_| (4.0_f32, -2.0_f32, 0.25_f32, 0.5_f32)),
        )
        .write()
        .non_parallel()
        .to_buffered(&mut encoded)?;
        let encoded = encoded.into_inner();
        std::fs::write(&self.path, &encoded)?;
        let (mut left, mut right) = (0x811c9dc5_u32, 0x9e3779b9_u32);
        for byte in &encoded {
            left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        let descriptor = ResourceDescriptor::MediaSource(MediaSourceDescriptor {
            source_id: CompositionIdentity::Unicode("hdr-image".into()),
            content_identity: format!("fnv64:{left:08x}{right:08x}:{}", encoded.len()),
            authorization_scope: "test:hdr".into(),
            media_kind: MediaKind::Image,
        });
        let source = ResourceHash::for_resource(ResourceKind::MediaSource, &descriptor, &[])?;
        registry.put(
            PutResource {
                hash: source.clone(),
                kind: ResourceKind::MediaSource,
                descriptor,
            },
            vec![],
        )?;
        let descriptor = ResourceDescriptor::MediaFrame(MediaFrameDescriptor {
            source: source.clone(),
            sample: MediaSample::Image,
            width: 2,
            height: 1,
            format: MediaTextureFormat::Rgba16Float,
        });
        let frame = ResourceHash::for_resource(ResourceKind::MediaFrame, &descriptor, &[])?;
        registry.put(
            PutResource {
                hash: frame.clone(),
                kind: ResourceKind::MediaFrame,
                descriptor,
            },
            vec![],
        )?;
        let decoder = NativeStillDecoder::new(
            "unused-ffmpeg".into(),
            vec![StillAuthorization {
                source,
                scope: "test:hdr".into(),
                path: self.path.clone(),
                sha256: format!("{:x}", Sha256::digest(&encoded)),
            }],
            StillLimits {
                still_max_source_bytes: 65536,
                still_max_pixel_bytes: 1024,
                still_max_dimension: 16,
                still_timeout_ms: 30000,
                still_max_header_bytes: 4096,
            },
        )?;
        let decoded =
            decoder.decode(&frame, registry, &aster_video::CancellationToken::default())?;
        assert_eq!(decoded.receipt.backend, "rust-exr-snapshot");
        assert_eq!(decoded.receipt.format, MediaTextureFormat::Rgba16Float);
        let descriptor = BufferResourceDescriptor {
            element_type: ElementType::U8,
            element_count: decoded.bytes.len() as u32,
            byte_length: decoded.bytes.len() as u32,
        };
        let pixels = ResourceHash::for_buffer(&descriptor, &decoded.bytes)?;
        registry.put(
            PutResource {
                hash: pixels.clone(),
                kind: ResourceKind::Buffer,
                descriptor: ResourceDescriptor::Buffer(descriptor),
            },
            decoded.bytes,
        )?;
        Ok(ImageInput {
            frame,
            pixels,
            width: 2,
            height: 1,
            format: MediaTextureFormat::Rgba16Float,
        })
    }
}

#[test]
#[ignore = "requires GPU"]
fn native_image_cache_preserves_exr_hdr_through_shared_shader()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = HdrFixture {
        path: std::env::temp_dir().join(format!("aster-hdr-{}.exr", uuid::Uuid::new_v4())),
    };
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    let input = fixture.input(&mut registry)?;
    let mut renderer = NativeRenderer::new(NativeOptions {
        dxcompiler: None,
        backend: if cfg!(target_os = "windows") {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
        adapter_name: None,
        gpu_budget_bytes: 1024 * 1024,
        timeout: Duration::from_secs(30),
    })?;
    let inputs = BTreeMap::from([(input.frame.clone(), input.clone())]);
    assert!(
        renderer
            .images
            .prepare(
                (&renderer.device, &renderer.queue),
                &inputs,
                &registry,
                15,
                renderer.options.timeout
            )
            .is_err()
    );
    assert_eq!(renderer.images.statistics.uploads, 0);
    renderer.images.prepare(
        (&renderer.device, &renderer.queue),
        &inputs,
        &registry,
        16,
        renderer.options.timeout,
    )?;
    assert_eq!(renderer.images.statistics.resident_bytes, 16);
    let source = aster_shaders::ShaderCatalog::embedded()?
        .program("scene-image")?
        .source
        .clone();
    let module = renderer
        .device
        .create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("HDR shared image"),
            source: wgpu::ShaderSource::Wgsl(source.into()),
        });
    let pipelines = GeometryPipelines::create(&renderer.device, &module, &renderer.images.layout);
    let mut vertices = Vec::new();
    for (x, y) in [
        (-1.0_f32, -1.0_f32),
        (1.0, -1.0),
        (-1.0, 1.0),
        (-1.0, 1.0),
        (1.0, -1.0),
        (1.0, 1.0),
    ] {
        let mut values = [0.0_f32; 40];
        values[..9].copy_from_slice(&[x, y, 0.0, 0.5, 0.5, 1.0, 1.0, 1.0, 1.0]);
        for value in values {
            vertices.extend_from_slice(&value.to_le_bytes());
        }
    }
    let vertices = renderer
        .device
        .create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("HDR quad"),
            contents: &vertices,
            usage: wgpu::BufferUsages::VERTEX,
        });
    let color = renderer.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("HDR result"),
        size: wgpu::Extent3d {
            width: 1,
            height: 1,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let depth = renderer.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("HDR depth"),
        size: color.size(),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth24Plus,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("HDR readback"),
        size: 256,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = renderer.device.create_command_encoder(&Default::default());
    {
        let color_view = color.create_view(&Default::default());
        let depth_view = depth.create_view(&Default::default());
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("HDR image sample"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &color_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations {
                    load: wgpu::LoadOp::Clear(1.0),
                    store: wgpu::StoreOp::Discard,
                }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(pipelines.get(&0).ok_or("missing image pipeline")?);
        pass.set_bind_group(0, renderer.images.binding(&input)?, &[]);
        pass.set_vertex_buffer(0, vertices.slice(..));
        pass.draw(0..6, 0..1);
    }
    encoder.copy_texture_to_buffer(
        color.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(1),
            },
        },
        color.size(),
    );
    let submission = renderer.queue.submit([encoder.finish()]);
    let (sender, receiver) = mpsc::sync_channel(1);
    buffer
        .slice(..)
        .map_async(wgpu::MapMode::Read, move |value| {
            let _ = sender.send(value);
        });
    renderer.device.poll(wgpu::PollType::Wait {
        submission_index: Some(submission),
        timeout: Some(renderer.options.timeout),
    })?;
    receiver.recv_timeout(renderer.options.timeout)??;
    let mapped = buffer.slice(..).get_mapped_range()?;
    let actual: Vec<_> = mapped[..8]
        .chunks_exact(2)
        .map(|pair| f16::from_bits(u16::from_le_bytes([pair[0], pair[1]])).to_f32())
        .collect();
    assert_eq!(actual, [4.0, -2.0, 0.25, 0.5]);
    drop(mapped);
    buffer.unmap();
    renderer.images.prepare(
        (&renderer.device, &renderer.queue),
        &inputs,
        &registry,
        16,
        renderer.options.timeout,
    )?;
    assert_eq!(renderer.images.statistics.uploads, 1);
    assert_eq!(renderer.images.statistics.hits, 1);
    Ok(())
}

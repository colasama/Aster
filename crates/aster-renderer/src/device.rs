use std::{
    sync::{Arc, Weak, mpsc},
    time::Duration,
};

use aster_render::{AdapterDiagnostics, NativeBackend, TextureResource, TextureResourceDescriptor};
use aster_render_ir::{AntiAliasing, Extent2d};
use aster_shaders::ShaderCatalog;

use crate::{RenderError, SuppliedFrame, output::OutputPipelines, scene::ScenePipelines};

#[cfg(test)]
#[path = "hdr_image_tests.rs"]
mod hdr_image_tests;
#[cfg(test)]
#[path = "image_cache_tests.rs"]
mod image_cache_tests;

pub struct NativeOptions {
    pub backend: NativeBackend,
    pub adapter_name: Option<String>,
    pub gpu_budget_bytes: u64,
    pub timeout: Duration,
}

pub struct RenderedFrame {
    pub texture: wgpu::Texture,
    pub size: Extent2d,
    pub submission: wgpu::SubmissionIndex,
    pub image_cache: crate::ImageCacheStatistics,
    _lease: Arc<()>,
}

struct FrameTargets {
    render_size: Extent2d,
    output_size: Extent2d,
    scene: TextureResource,
    depth: TextureResource,
    display: TextureResource,
    output: TextureResource,
}

pub struct NativeRenderer {
    pub diagnostics: AdapterDiagnostics,
    device: wgpu::Device,
    queue: wgpu::Queue,
    options: NativeOptions,
    scene: ScenePipelines,
    output: OutputPipelines,
    targets: Option<FrameTargets>,
    output_lease: Weak<()>,
    images: crate::image_cache::ImageCache,
}

impl FrameTargets {
    fn new(device: &wgpu::Device, render_size: Extent2d, output_size: Extent2d) -> Self {
        let texture = |label, size: Extent2d, format, usage| {
            TextureResource::create(
                device,
                TextureResourceDescriptor::texture_2d(
                    label,
                    size.width,
                    size.height,
                    format,
                    usage,
                ),
            )
        };
        let sampled = wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING;
        Self {
            render_size,
            output_size,
            scene: texture(
                "Linear HDR scene",
                render_size,
                wgpu::TextureFormat::Rgba16Float,
                sampled | wgpu::TextureUsages::COPY_SRC,
            ),
            depth: texture(
                "Scene depth",
                render_size,
                wgpu::TextureFormat::Depth24Plus,
                wgpu::TextureUsages::RENDER_ATTACHMENT,
            ),
            display: texture(
                "Display AA input",
                render_size,
                wgpu::TextureFormat::Bgra8Unorm,
                sampled,
            ),
            output: texture(
                "Native output",
                output_size,
                wgpu::TextureFormat::Bgra8Unorm,
                sampled | wgpu::TextureUsages::COPY_SRC,
            ),
        }
    }
}

impl NativeRenderer {
    pub fn new(options: NativeOptions) -> Result<Self, RenderError> {
        if options.gpu_budget_bytes == 0 || options.timeout.is_zero() {
            return Err(RenderError::Invalid(
                "GPU budget and timeout must be positive".into(),
            ));
        }
        let backends = match options.backend {
            NativeBackend::Dx12 => wgpu::Backends::DX12,
            NativeBackend::Metal => wgpu::Backends::METAL,
            NativeBackend::Vulkan => wgpu::Backends::VULKAN,
        };
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let adapter = pollster::block_on(instance.enumerate_adapters(backends))
            .into_iter()
            .filter(|adapter| {
                let info = adapter.get_info();
                info.device_type != wgpu::DeviceType::Cpu
                    && options
                        .adapter_name
                        .as_ref()
                        .is_none_or(|name| info.name == *name)
            })
            .max_by_key(|adapter| match adapter.get_info().device_type {
                wgpu::DeviceType::DiscreteGpu => 3,
                wgpu::DeviceType::IntegratedGpu => 2,
                _ => 1,
            })
            .ok_or_else(|| RenderError::Gpu("no matching hardware adapter".into()))?;
        let diagnostics = AdapterDiagnostics::from_adapter(&adapter);
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Aster native renderer"),
            required_limits: wgpu::Limits {
                max_texture_dimension_2d: adapter.limits().max_texture_dimension_2d,
                ..Default::default()
            },
            ..Default::default()
        }))
        .map_err(|error| RenderError::Gpu(error.to_string()))?;
        let memory_scope = device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal_scope = device.push_error_scope(wgpu::ErrorFilter::Internal);
        let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
        let catalog = ShaderCatalog::embedded()?;
        let images = crate::image_cache::ImageCache::new(&device);
        let scene = ScenePipelines::new(&device, &catalog, &images.layout)?;
        let output = OutputPipelines::new(&device, &queue, &catalog)?;
        let validation_error = pollster::block_on(scope.pop());
        let internal_error = pollster::block_on(internal_scope.pop());
        let memory_error = pollster::block_on(memory_scope.pop());
        if let Some(error) = validation_error.or(internal_error).or(memory_error) {
            return Err(RenderError::Gpu(error.to_string()));
        }
        Ok(Self {
            diagnostics,
            device,
            queue,
            options,
            scene,
            output,
            targets: None,
            output_lease: Weak::new(),
            images,
        })
    }

    /// Executes only supplied inputs; the returned frame remains on the GPU.
    pub fn render(
        &mut self,
        frame: &SuppliedFrame,
        registry: &aster_render_ir::ResourceRegistry,
    ) -> Result<RenderedFrame, RenderError> {
        if self.output_lease.upgrade().is_some() {
            return Err(RenderError::Invalid(
                "previous output frame is still leased".into(),
            ));
        }
        let render_size = frame.header.render_target;
        let size = frame.header.target;
        let bytes = u64::from(render_size.width)
            * u64::from(render_size.height)
            * (16 + if frame.layers.is_empty() { 0 } else { 20 })
            + u64::from(size.width) * u64::from(size.height) * 4
            + frame.vertices.len() as u64
            + 8192;
        if bytes > self.options.gpu_budget_bytes
            || [
                render_size.width,
                render_size.height,
                size.width,
                size.height,
            ]
            .into_iter()
            .any(|dimension| dimension > self.device.limits().max_texture_dimension_2d)
        {
            return Err(RenderError::Invalid(
                "frame exceeds GPU allocation budget or dimensions".into(),
            ));
        }
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let resized = self.targets.as_ref().is_none_or(|targets| {
            targets.render_size != render_size || targets.output_size != size
        });
        if resized && self.targets.is_some() {
            self.device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(self.options.timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            self.targets = None;
        }
        self.images.prepare(
            (&self.device, &self.queue),
            &frame.images,
            registry,
            self.options.gpu_budget_bytes - bytes,
            self.options.timeout,
        )?;
        if resized {
            self.targets = Some(FrameTargets::new(&self.device, render_size, size));
        }
        let targets = self
            .targets
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("frame allocation missing".into()))?;
        let scene = targets.scene.create_view(&Default::default());
        let depth = targets.depth.create_view(&Default::default());
        let display = targets.display.create_view(&Default::default());
        let output = targets.output.create_view(&Default::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Supplied native frame"),
            });
        self.scene.record(
            &self.device,
            &mut encoder,
            frame,
            (targets.scene.raw(), &depth),
            &self.images,
            &self.output,
        )?;
        self.output.record(
            &self.device,
            &mut encoder,
            frame,
            &scene,
            if frame.header.aa == AntiAliasing::Off {
                &output
            } else {
                &display
            },
            &output,
        )?;
        let submission = self.queue.submit([encoder.finish()]);
        let validation_error = pollster::block_on(validation.pop());
        let internal_error = pollster::block_on(internal.pop());
        let memory_error = pollster::block_on(memory.pop());
        if let Some(error) = validation_error.or(internal_error).or(memory_error) {
            self.images.invalidate();
            return Err(RenderError::Gpu(error.to_string()));
        }
        let lease = Arc::new(());
        self.output_lease = Arc::downgrade(&lease);
        Ok(RenderedFrame {
            texture: targets.output.raw().clone(),
            size,
            submission,
            image_cache: self.images.statistics,
            _lease: lease,
        })
    }

    /// Explicit diagnostic readback. Preview and encoder integrations consume the texture directly.
    pub fn read_rgba(&self, frame: &RenderedFrame) -> Result<Vec<u8>, RenderError> {
        let row = frame.size.width * 4;
        let padded = row.div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Diagnostic RGBA readback"),
            size: u64::from(padded) * u64::from(frame.size.height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        encoder.copy_texture_to_buffer(
            frame.texture.as_image_copy(),
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(frame.size.height),
                },
            },
            wgpu::Extent3d {
                width: frame.size.width,
                height: frame.size.height,
                depth_or_array_layers: 1,
            },
        );
        let submission = self.queue.submit([encoder.finish()]);
        let (sender, receiver) = mpsc::sync_channel(1);
        buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        self.device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(self.options.timeout),
            })
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        receiver
            .recv_timeout(self.options.timeout)
            .map_err(|error| RenderError::Gpu(error.to_string()))?
            .map_err(|error| RenderError::Gpu(error.to_string()))?;
        let mut pixels = Vec::with_capacity(row as usize * frame.size.height as usize);
        {
            let mapped = buffer
                .slice(..)
                .get_mapped_range()
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            for bytes in mapped.chunks_exact(padded as usize) {
                for bgra in bytes[..row as usize].chunks_exact(4) {
                    pixels.extend([bgra[2], bgra[1], bgra[0], bgra[3]]);
                }
            }
        }
        buffer.unmap();
        Ok(pixels)
    }
}

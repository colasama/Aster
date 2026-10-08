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
#[cfg(test)]
#[path = "surface_cache_tests.rs"]
mod surface_cache_tests;
#[cfg(test)]
#[path = "surface_post_tests.rs"]
mod surface_post_tests;
#[cfg(test)]
#[path = "temporal_text_tests.rs"]
mod temporal_text_tests;

pub struct NativeOptions {
    pub backend: NativeBackend,
    pub adapter_name: Option<String>,
    /// Explicit DXC library supplied by the application host on Windows.
    pub dxcompiler: Option<std::path::PathBuf>,
    pub gpu_budget_bytes: u64,
    /// Optional GPU-resident post-effect cache limit; zero disables result reuse.
    pub layer_cache_bytes: u64,
    pub effect_regions: bool,
    pub timeout: Duration,
}

pub struct RenderedFrame {
    pub texture: wgpu::Texture,
    pub size: Extent2d,
    pub submission: wgpu::SubmissionIndex,
    pub image_cache: crate::ImageCacheStatistics,
    pub lut_cache: crate::LutCacheStatistics,
    pub surface_cache: crate::SurfaceCacheStatistics,
    pub layer_cache: crate::LayerCacheStatistics,
    pub effect_regions: crate::EffectRegionStatistics,
    pub temporal_cache: crate::TemporalCacheStatistics,
    pub motion_reconstruction: crate::MotionStatistics,
    pub depth_effects: crate::DepthStatistics,
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
    surface_output: Option<crate::surface_output::SurfaceOutput>,
    depth_output: Option<crate::depth_output::DepthOutput>,
    visualizer: Option<crate::visualizer::Visualizer>,
    targets: Option<FrameTargets>,
    output_lease: Weak<()>,
    images: crate::image_cache::ImageCache,
    surfaces: crate::surface_cache::SurfaceCache,
    layer_cache: crate::layer_cache::LayerCache,
    temporal: crate::temporal_cache::TemporalCache,
    motion_output: Option<crate::motion_output::MotionOutput>,
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
                sampled | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
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
        let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
        descriptor.backends = backends;
        if let Some(path) = &options.dxcompiler {
            let absolute = path
                .canonicalize()
                .map_err(|error| RenderError::Invalid(format!("DXC library: {error}")))?;
            if !absolute.is_file() || backends != wgpu::Backends::DX12 {
                return Err(RenderError::Invalid(
                    "DXC requires a regular library file and DX12".into(),
                ));
            }
            descriptor.backend_options.dx12.shader_compiler = wgpu::Dx12Compiler::DynamicDxc {
                dxc_path: absolute
                    .to_str()
                    .ok_or_else(|| RenderError::Invalid("DXC path is not Unicode".into()))?
                    .to_owned(),
            };
        }
        let instance = wgpu::Instance::new(descriptor);
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
            surface_output: None,
            depth_output: None,
            visualizer: None,
            targets: None,
            output_lease: Weak::new(),
            images,
            surfaces: Default::default(),
            layer_cache: Default::default(),
            temporal: Default::default(),
            motion_output: None,
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
        let render_size = frame.scene.header.render_target;
        let size = frame.scene.header.target;
        let has_generators = std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|s| &s.scene))
            .any(|s| !s.generators.is_empty());
        let lut_bytes = frame.luts.values().map(|input| input.bytes).sum::<u64>();
        let surface_bytes = frame
            .surfaces
            .targets
            .iter()
            .map(|t| u64::from(t.size.width) * u64::from(t.size.height) * 12)
            .sum::<u64>();
        let bytes = frame
            .motion
            .as_ref()
            .map_or(0, crate::frame_motion::FrameMotion::required_bytes)
            + frame
                .depth
                .as_ref()
                .map_or(0, crate::frame_depth::FrameDepth::required_bytes)
            + frame.temporal.required_bytes()
            + frame
                .visualizer
                .as_ref()
                .map_or(0, crate::frame_visualizer::FrameVisualizer::required_bytes)
            + u64::from(render_size.width) * u64::from(render_size.height) * 16
            + u64::from(size.width) * u64::from(size.height) * 4
            + frame.scene.transient_bytes()
            + u64::from(has_generators) * 9280
            + if frame.scene.shadow_draws.is_empty() {
                0
            } else {
                u64::from(frame.scene.shadow_size).pow(2) * 4
            }
            + frame.surface.as_ref().map_or(0, |surface| {
                32 + surface
                    .auxiliary
                    .as_ref()
                    .map_or(0, crate::AuxiliaryPrimaryPlan::required_bytes)
            })
            + frame
                .surfaces
                .targets
                .iter()
                .map(|t| t.scene.transient_bytes())
                .sum::<u64>();
        if bytes + surface_bytes + lut_bytes > self.options.gpu_budget_bytes
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
        if has_generators && self.scene.generators.is_none() {
            self.scene.generators = Some(crate::generators::GeneratorPipelines::new(&self.device));
        }
        if let Some(generators) = &mut self.scene.generators {
            generators.prepare(&self.device, frame)?;
        }
        if std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|s| &s.scene))
            .any(|s| s.materials.values().any(|m| m.active))
        {
            self.scene.prepare_materials(&self.device, &self.queue)?;
        }
        if frame.visualizer.is_some() && self.visualizer.is_none() {
            self.visualizer = Some(crate::visualizer::Visualizer::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if frame.depth.is_some() && self.depth_output.is_none() {
            self.depth_output = Some(crate::depth_output::DepthOutput::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if frame.surface.is_some() && self.surface_output.is_none() {
            self.surface_output = Some(crate::surface_output::SurfaceOutput::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|s| &s.scene))
            .any(|s| s.layers.values().any(|l| !l.operations.is_empty()))
        {
            self.output.prepare_effects(&self.device)?;
        }
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
        let required_images = frame
            .images
            .values()
            .map(|image| {
                u64::from(image.width)
                    * u64::from(image.height)
                    * u64::from(image.format.bytes_per_pixel())
            })
            .sum::<u64>();
        let cache_budget = (self.options.gpu_budget_bytes - bytes - surface_bytes - lut_bytes)
            .saturating_sub(required_images)
            .min(self.options.layer_cache_bytes);
        if required_images > self.options.gpu_budget_bytes - bytes - surface_bytes - lut_bytes {
            return Err(RenderError::Invalid(
                "images exceed GPU allocation budget".into(),
            ));
        }
        if frame.motion.is_some() && self.motion_output.is_none() {
            self.motion_output = Some(crate::motion_output::MotionOutput::new(
                &self.device,
                &self.images.layout,
            )?);
        }
        if let Some(motion) = &mut self.motion_output {
            motion.retire(&self.device, frame.motion.as_ref(), self.options.timeout)?;
        }
        if let Some(depth) = &mut self.depth_output {
            depth.retire(&self.device, frame.depth.as_ref(), self.options.timeout)?;
        }
        self.images.install_derived(&self.device, Vec::new());
        self.temporal.retire(
            &self.device,
            &frame.temporal,
            frame.temporal.required_bytes(),
            self.options.timeout,
        )?;
        let scenes = std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|surface| &surface.scene))
            .collect::<Vec<_>>();
        let generations = if cache_budget > 0 {
            crate::surface_generation::SurfaceGenerations::collect(&frame.surfaces)?
        } else {
            Default::default()
        };
        let cache_reserved = self.layer_cache.prepare(
            &self.device,
            &scenes,
            generations,
            cache_budget,
            self.options.timeout,
        )?;
        self.images.prepare(
            (&self.device, &self.queue),
            &frame.images,
            registry,
            self.options.gpu_budget_bytes - bytes - surface_bytes - lut_bytes - cache_reserved,
            self.options.timeout,
        )?;
        self.temporal.prepare(
            &self.device,
            &frame.temporal,
            &frame.images,
            &mut self.images,
        )?;
        self.output.luts.prepare(
            (&self.device, &self.queue),
            &frame.luts,
            registry,
            self.options.gpu_budget_bytes
                - cache_reserved
                - bytes
                - surface_bytes
                - self.images.statistics.resident_bytes,
            self.options.timeout,
        )?;
        self.surfaces.prepare(
            &self.device,
            &self.images.layout,
            &frame.surfaces,
            self.options.gpu_budget_bytes
                - cache_reserved
                - bytes
                - self.images.statistics.resident_bytes
                - self.output.luts.statistics.resident_bytes,
            self.options.timeout,
        )?;
        self.layer_cache.allocate(&self.device);
        if let Some(motion) = &mut self.motion_output {
            motion.allocate(&self.device, frame.motion.as_ref())?;
        }
        if let Some(depth) = &mut self.depth_output {
            depth.allocate(&self.device, frame.depth.as_ref())?;
        }
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
        let mut effect_regions = crate::effect_region::EffectRegions {
            enabled: self.options.effect_regions,
            statistics: Default::default(),
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Supplied native frame"),
            });
        self.temporal.record(&mut encoder, &frame.temporal)?;
        for input in &frame.surfaces.targets {
            let target = self.surfaces.target(&input.key)?;
            self.scene.record(
                &self.device,
                &mut encoder,
                &input.scene,
                (&target.color, &target.depth),
                (
                    &self.images,
                    &self.surfaces,
                    &frame.surfaces,
                    &mut self.layer_cache,
                    &mut effect_regions,
                ),
                &self.output,
            )?;
        }
        let generator_draws = self.scene.record(
            &self.device,
            &mut encoder,
            &frame.scene,
            (targets.scene.raw(), &depth),
            (
                &self.images,
                &self.surfaces,
                &frame.surfaces,
                &mut self.layer_cache,
                &mut effect_regions,
            ),
            &self.output,
        )?;
        let motion = if frame.motion.is_some() {
            Some(
                self.motion_output
                    .as_ref()
                    .ok_or_else(|| RenderError::Invalid("motion pipeline missing".into()))?
                    .record(
                        &self.device,
                        &mut encoder,
                        frame,
                        targets.scene.raw(),
                        (&self.images, &self.surfaces, &generator_draws),
                    )?,
            )
        } else {
            None
        };
        let scene = motion
            .as_ref()
            .map_or(scene, |texture| texture.create_view(&Default::default()));
        if frame.visualizer.is_some() {
            let destination = if frame.scene.header.aa == AntiAliasing::Off {
                targets.output.raw()
            } else {
                targets.display.raw()
            };
            self.visualizer
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("visualizer missing".into()))?
                .record(
                    &self.device,
                    &mut encoder,
                    frame,
                    (targets.scene.raw(), destination),
                    (&self.images, &self.surfaces, &generator_draws),
                )?;
            self.output.record_aa(
                &self.device,
                &mut encoder,
                frame.scene.header.aa,
                &display,
                &output,
            )?;
        } else if frame.depth.is_some() {
            let destination = if frame.scene.header.aa == AntiAliasing::Off {
                targets.output.raw()
            } else {
                targets.display.raw()
            };
            self.depth_output
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("depth pipeline missing".into()))?
                .record(
                    &self.device,
                    &mut encoder,
                    frame,
                    (targets.scene.raw(), motion.as_ref(), destination),
                    (&self.images, &self.surfaces, &generator_draws),
                )?;
            self.output.record_aa(
                &self.device,
                &mut encoder,
                frame.scene.header.aa,
                &display,
                &output,
            )?;
        } else if frame.surface.is_some() {
            let destination = if frame.scene.header.aa == AntiAliasing::Off {
                targets.output.raw()
            } else {
                targets.display.raw()
            };
            self.surface_output
                .as_ref()
                .ok_or_else(|| RenderError::Invalid("surface pipeline missing".into()))?
                .record(
                    &self.device,
                    &mut encoder,
                    frame,
                    (targets.scene.raw(), destination),
                    (&self.images, &self.surfaces, &generator_draws),
                )?;
            self.output.record_aa(
                &self.device,
                &mut encoder,
                frame.scene.header.aa,
                &display,
                &output,
            )?;
        } else {
            self.output.record(
                &self.device,
                &mut encoder,
                frame,
                &scene,
                if frame.scene.header.aa == AntiAliasing::Off {
                    &output
                } else {
                    &display
                },
                &output,
            )?;
        }
        let submission = self.queue.submit([encoder.finish()]);
        let validation_error = pollster::block_on(validation.pop());
        let internal_error = pollster::block_on(internal.pop());
        let memory_error = pollster::block_on(memory.pop());
        if let Some(error) = validation_error.or(internal_error).or(memory_error) {
            self.layer_cache.invalidate();
            self.images.invalidate();
            self.temporal.invalidate();
            self.motion_output = None;
            self.depth_output = None;
            self.surfaces.invalidate();
            self.output.luts.invalidate();
            return Err(RenderError::Gpu(error.to_string()));
        }
        self.layer_cache.commit();
        let lease = Arc::new(());
        self.output_lease = Arc::downgrade(&lease);
        Ok(RenderedFrame {
            texture: targets.output.raw().clone(),
            size,
            submission,
            image_cache: self.images.statistics,
            lut_cache: self.output.luts.statistics,
            surface_cache: self.surfaces.statistics,
            layer_cache: self.layer_cache.statistics,
            effect_regions: effect_regions.statistics,
            temporal_cache: self.temporal.statistics,
            motion_reconstruction: self
                .motion_output
                .as_ref()
                .map_or_else(Default::default, |m| m.statistics),
            depth_effects: self
                .depth_output
                .as_ref()
                .map_or_else(Default::default, |d| d.statistics),
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

#[cfg(test)]
#[path = "auxiliary_primary_tests.rs"]
mod auxiliary_primary_tests;

#[cfg(test)]
#[path = "layer_cache_tests.rs"]
mod layer_cache_tests;

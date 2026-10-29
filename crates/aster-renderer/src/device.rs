use std::{
    sync::{Arc, Weak},
    time::Duration,
};

use aster_render::{AdapterDiagnostics, NativeBackend, TextureResource, TextureResourceDescriptor};
use aster_render_ir::{AntiAliasing, Extent2d};
use aster_shaders::ShaderCatalog;

use crate::{RenderError, SuppliedFrame, output::OutputPipelines, scene::ScenePipelines};

#[path = "diagnostic_readback.rs"]
mod diagnostic_readback;

#[path = "project_allocation.rs"]
mod project_allocation;
pub use project_allocation::{ProjectDeviceLimits, ProjectSurfaceTarget};
#[path = "project_output.rs"]
mod project_output;
pub use project_output::{ProjectOutputAvailability, ProjectOutputRequest};
#[cfg(test)]
#[path = "project_allocation_tests.rs"]
mod project_allocation_tests;

#[cfg(all(test, windows))]
#[path = "generator_storage_tests.rs"]
mod generator_storage_tests;
#[cfg(windows)]
#[path = "shared_nv12_output.rs"]
mod shared_nv12_output;
#[cfg(all(test, windows))]
#[path = "shared_nv12_tests.rs"]
mod shared_nv12_tests;
#[cfg(any(windows, target_os = "macos"))]
#[path = "shared_preview_output.rs"]
mod shared_preview_output;
#[cfg(all(test, windows))]
#[path = "shared_preview_tests.rs"]
mod shared_preview_tests;

#[cfg(test)]
#[path = "glyph_frame_tests.rs"]
mod glyph_frame_tests;
#[cfg(test)]
#[path = "glyph_text_tests.rs"]
mod glyph_text_tests;
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
    /// Maximum specialized opcode pipelines; zero uses the complete shared shader.
    pub effect_pipeline_entries: usize,
    /// Opt-in timestamp queries and tiny readbacks; never enable for throughput acceptance.
    pub gpu_timestamps: bool,
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
    glyphs: crate::glyph_cache::GlyphCache,
    motion_output: Option<crate::motion_output::MotionOutput>,
    nv12: Option<crate::nv12::Nv12Converter>,
    gpu_profiler: Option<crate::gpu_profile::GpuProfiler>,
    gpu_timings: Option<crate::GpuTimings>,
    project_preparation: Option<project_allocation::ProjectPreparation>,
    project_outputs: Option<project_output::ProjectOutputTargets>,
    #[cfg(windows)]
    shared_nv12: Vec<Arc<crate::shared_nv12::SharedNv12Target>>,
    #[cfg(windows)]
    shared_nv12_reserved_bytes: u64,
    #[cfg(any(windows, target_os = "macos"))]
    shared_preview: Vec<Arc<crate::shared_preview::SharedPreviewTarget>>,
    #[cfg(any(windows, target_os = "macos"))]
    shared_preview_reserved_bytes: u64,
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
    /// Identifies the actual DX12 device used for rendering, not a friendly-name approximation.
    pub fn adapter_luid(&self) -> Option<aster_render_ir::AdapterLuid> {
        #[cfg(windows)]
        {
            // Only read identity while the HAL guard retains the underlying device.
            let device = unsafe { self.device.as_hal::<wgpu::hal::api::Dx12>() }?;
            let luid = unsafe { device.raw_device().GetAdapterLuid() };
            Some(aster_render_ir::AdapterLuid {
                low: luid.LowPart,
                high: luid.HighPart,
            })
        }
        #[cfg(not(windows))]
        {
            None
        }
    }

    pub fn new(options: NativeOptions) -> Result<Self, RenderError> {
        Self::new_for_adapter(options, None)
    }

    pub fn new_for_adapter(
        mut options: NativeOptions,
        adapter_luid: Option<aster_render_ir::AdapterLuid>,
    ) -> Result<Self, RenderError> {
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
                    && crate::adapter_identity::AdapterSelection::matches(adapter, adapter_luid)
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
        let required_features = if options.gpu_timestamps {
            options.gpu_budget_bytes = options
                .gpu_budget_bytes
                .checked_sub(2176)
                .filter(|remaining| *remaining > 0)
                .ok_or_else(|| {
                    RenderError::Invalid("GPU timestamp buffers exceed budget".into())
                })?;
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS
        } else {
            wgpu::Features::empty()
        };
        if !adapter.features().contains(required_features) {
            return Err(RenderError::Unsupported(
                "diagnostic GPU timestamp queries".into(),
            ));
        }
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Aster native renderer"),
            required_features,
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
        let gpu_profiler = options
            .gpu_timestamps
            .then(|| crate::gpu_profile::GpuProfiler::new(&device, &queue));
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
            glyphs: Default::default(),
            motion_output: None,
            nv12: None,
            gpu_profiler,
            gpu_timings: None,
            project_preparation: None,
            project_outputs: None,
            #[cfg(windows)]
            shared_nv12: Vec::new(),
            #[cfg(windows)]
            shared_nv12_reserved_bytes: 0,
            #[cfg(any(windows, target_os = "macos"))]
            shared_preview: Vec::new(),
            #[cfg(any(windows, target_os = "macos"))]
            shared_preview_reserved_bytes: 0,
        })
    }

    /// Reserve a fixed-size, reusable output slot before rendering an export session.
    pub fn prepare_nv12(&mut self, size: Extent2d) -> Result<(), RenderError> {
        if let Some(converter) = &self.nv12 {
            return if converter.size == size {
                Ok(())
            } else {
                Err(RenderError::Invalid(
                    "NV12 export dimensions cannot change".into(),
                ))
            };
        }
        if self.targets.is_some() {
            return Err(RenderError::Invalid(
                "prepare NV12 before rendering frames".into(),
            ));
        }
        let bytes = crate::nv12::Nv12Converter::required_bytes(size)?;
        let remaining = self
            .options
            .gpu_budget_bytes
            .checked_sub(bytes)
            .filter(|remaining| *remaining > 0)
            .ok_or_else(|| RenderError::Invalid("NV12 conversion exceeds GPU budget".into()))?;
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let converter = crate::nv12::Nv12Converter::new(&self.device, size);
        let errors = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ];
        if let Some(error) = errors.into_iter().flatten().next() {
            return Err(RenderError::Gpu(error.to_string()));
        }
        self.nv12 = Some(converter?);
        self.options.gpu_budget_bytes = remaining;
        Ok(())
    }

    /// Native readback fallback; final RGBA never traverses the sidecar pipe.
    pub fn read_nv12(&mut self, frame: &RenderedFrame) -> Result<Vec<u8>, RenderError> {
        let converter = self
            .nv12
            .as_ref()
            .ok_or_else(|| RenderError::Invalid("NV12 output is not prepared".into()))?;
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let pixels = converter.read(
            &self.device,
            &self.queue,
            &frame.texture,
            self.options.timeout,
            self.gpu_profiler.as_ref(),
        );
        let errors = [
            pollster::block_on(validation.pop()),
            pollster::block_on(internal.pop()),
            pollster::block_on(memory.pop()),
        ];
        if let Some(error) = errors.into_iter().flatten().next() {
            return Err(RenderError::Gpu(error.to_string()));
        }
        let pixels = pixels?;
        if let Some(profile) = &self.gpu_profiler {
            let times = profile.read(&self.device, self.options.timeout, 3)?;
            let timing = self.gpu_timings.get_or_insert_with(Default::default);
            timing.nv12_conversion_ms = times[0];
            timing.nv12_copy_ms = times[1];
        }
        Ok(pixels)
    }

    pub fn gpu_timings(&self) -> Option<crate::GpuTimings> {
        self.gpu_timings.clone()
    }

    /// Executes only supplied inputs; the returned frame remains on the GPU.
    pub fn render(
        &mut self,
        frame: &SuppliedFrame,
        registry: &aster_render_ir::ResourceRegistry,
    ) -> Result<RenderedFrame, RenderError> {
        for input in frame.glyphs.inputs.values() {
            input.validate_device(&self.device.limits())?;
        }
        if self.output_lease.upgrade().is_some() {
            return Err(RenderError::Invalid(
                "previous output frame is still leased".into(),
            ));
        }
        if let Some(preparation) = &self.project_preparation {
            preparation.validate(frame)?;
            if let Some(output) = &self.project_outputs {
                output.validate(frame)?;
            }
        } else if self.project_outputs.is_some() {
            self.device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(self.options.timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            self.discard_project_outputs();
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
            + self
                .project_outputs
                .as_ref()
                .map_or(0, |output| output.additional_bytes(frame))
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
        let bytes = bytes
            .checked_add(frame.glyphs.bytes)
            .ok_or_else(|| RenderError::Invalid("frame GPU byte overflow".into()))?;
        if bytes
            .checked_add(surface_bytes)
            .and_then(|n| n.checked_add(lut_bytes))
            .is_none_or(|n| n > self.options.gpu_budget_bytes)
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
        self.images.clear_derived();
        self.temporal.retire(
            &self.device,
            &frame.temporal,
            frame.temporal.required_bytes(),
            self.options.timeout,
        )?;
        self.glyphs
            .retire(&self.device, &frame.glyphs, self.options.timeout)?;
        let memory = self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        let internal = self.device.push_error_scope(wgpu::ErrorFilter::Internal);
        let validation = self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        if has_generators && self.scene.generators.is_none() {
            self.scene.generators = Some(crate::generators::GeneratorPipelines::new(
                &self.device,
                self.scene.generator_overwrite.clone(),
            ));
        }
        if let Some(generators) = &mut self.scene.generators {
            generators.prepare(&self.device, frame, self.project_preparation.is_some())?;
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
            self.output.prepare_variants(
                &self.device,
                frame,
                self.options.effect_pipeline_entries,
            )?;
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
            .uploads
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
        let scenes = std::iter::once(&frame.scene)
            .chain(frame.surfaces.targets.iter().map(|surface| &surface.scene))
            .collect::<Vec<_>>();
        self.scene
            .layer_targets
            .retire(&self.device, &scenes, self.options.timeout)?;
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
            &frame.uploads,
            registry,
            self.options.gpu_budget_bytes - bytes - surface_bytes - lut_bytes - cache_reserved,
            self.options.timeout,
        )?;
        self.glyphs
            .prepare((&self.device, &self.queue), &frame.glyphs, &mut self.images)?;
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
        self.scene.layer_targets.allocate(&self.device);
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
        self.gpu_timings = None;
        if let Some(profile) = &self.gpu_profiler {
            profile.reset_frame();
            profile.mark(&mut encoder, 0);
        }
        self.glyphs.record(&mut encoder);
        self.temporal.record(&mut encoder, &frame.temporal)?;
        if let Some(profile) = &self.gpu_profiler {
            profile.mark(&mut encoder, 1);
        }
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
                    None,
                ),
                &self.output,
            )?;
        }
        if let Some(profile) = &self.gpu_profiler {
            profile.mark(&mut encoder, 2);
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
                self.gpu_profiler.as_ref(),
            ),
            &self.output,
        )?;
        if let Some(profile) = &self.gpu_profiler {
            profile.mark(&mut encoder, 3);
        }
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
                motion.as_ref().unwrap_or(targets.scene.raw()),
                if frame.scene.header.aa == AntiAliasing::Off {
                    &output
                } else {
                    &display
                },
                &output,
            )?;
        }
        if let Some(profile) = &self.gpu_profiler {
            profile.mark(&mut encoder, 4);
            profile.resolve_frame(&mut encoder);
        }
        let submission = self.queue.submit([encoder.finish()]);
        let validation_error = pollster::block_on(validation.pop());
        let internal_error = pollster::block_on(internal.pop());
        let memory_error = pollster::block_on(memory.pop());
        if let Some(error) = validation_error.or(internal_error).or(memory_error) {
            self.layer_cache.invalidate();
            self.images.invalidate();
            self.temporal.invalidate();
            self.glyphs.invalidate();
            self.motion_output = None;
            self.depth_output = None;
            self.surfaces.invalidate();
            self.output.luts.invalidate();
            return Err(RenderError::Gpu(error.to_string()));
        }
        self.layer_cache.commit();
        self.project_preparation = None;
        if let Some(profile) = &self.gpu_profiler {
            self.gpu_timings = Some(profile.read_frame(&self.device, self.options.timeout)?);
        }
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
}

#[cfg(test)]
#[path = "auxiliary_primary_tests.rs"]
mod auxiliary_primary_tests;

#[cfg(test)]
#[path = "layer_cache_tests.rs"]
mod layer_cache_tests;

#[cfg(test)]
#[path = "nv12_tests.rs"]
mod nv12_tests;

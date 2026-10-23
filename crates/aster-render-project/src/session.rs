use crate::{
    NativeProjectAudio, NativeProjectFileMedia, NativeProjectGpu, NativeProjectMaterials,
    ProjectRasterFrame, ProjectRenderError,
};
use aster_eval::{
    AuxiliaryBudget, BufferVisualization, DepthAttachments, DepthSettings, FrameOutputContext,
    FramePlanRequest, FrameSceneInputs, GeneratorCatalog, NativeBundle, ProjectFrameResources,
    ProjectResourceRequests, ResourceRequestContext,
};
use aster_render_ir::{
    DecodeLimits, PrecompositionMediaPixels, ResourceKind, ResourceLimits, ResourceRegistry,
};
use aster_renderer::{DecodedTexturePixels, RenderedFrame, SuppliedFrame};
use aster_video::CancellationToken;
use std::{collections::BTreeSet, sync::Arc, time::Instant};

mod inputs;
mod prefetch;

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectFrameSettings {
    pub resources: ResourceRequestContext,
    pub selected_layer_id: Option<String>,
    pub shadow_map_size: u32,
}

/// A frame is published only after acquisition, native planning and execution validation succeed.
pub struct PreparedProjectFrame {
    pub timings: crate::ProjectPreparationTimings,
    pub bundle: NativeBundle,
    pub frame: SuppliedFrame,
    pub registry: ResourceRegistry,
    pub decoded_images: Vec<PrecompositionMediaPixels>,
    pub text_routes: Vec<crate::ProjectTextRoute>,
    /// Immutable recipes for explicit diagnostics; ordinary execution remains GPU-resident.
    pub native_text: Vec<aster_renderer::NativeGlyphInput>,
    generation: u64,
    owner: Arc<()>,
}

pub struct NativeProjectSession {
    files: NativeProjectFileMedia,
    materials: NativeProjectMaterials,
    pub(crate) audio: NativeProjectAudio,
    catalog: GeneratorCatalog,
    analyze_audio: bool,
    pub gpu: NativeProjectGpu,
    generation: u64,
    pending: Option<u64>,
    poisoned: bool,
    owner: Arc<()>,
    text: Option<crate::NativeProjectText>,
}

impl NativeProjectSession {
    pub fn new(
        files: NativeProjectFileMedia,
        materials: NativeProjectMaterials,
        audio: NativeProjectAudio,
        gpu: NativeProjectGpu,
        catalog: GeneratorCatalog,
    ) -> Result<Self, ProjectRenderError> {
        if files.document.authored_sha256 != audio.project_sha256 {
            return Err(ProjectRenderError::Invalid(
                "audio and visual snapshots differ".into(),
            ));
        }
        let analyze_audio = files.document.scene.has_generators();
        Ok(Self {
            files,
            materials,
            audio,
            catalog,
            analyze_audio,
            gpu,
            generation: 0,
            pending: None,
            poisoned: false,
            owner: Arc::new(()),
            text: None,
        })
    }

    pub fn prepare(
        &mut self,
        frame: &FramePlanRequest,
        settings: &ProjectFrameSettings,
        cancellation: &CancellationToken,
        acquire_rasters: impl FnOnce(
            &ProjectResourceRequests,
        ) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<PreparedProjectFrame, ProjectRenderError> {
        self.prepare_inputs(frame, settings, None, cancellation, acquire_rasters)
    }

    fn prepare_inputs(
        &mut self,
        frame: &FramePlanRequest,
        settings: &ProjectFrameSettings,
        inputs: Option<inputs::PreparedProjectInputs>,
        cancellation: &CancellationToken,
        acquire_rasters: impl FnOnce(
            &ProjectResourceRequests,
        ) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<PreparedProjectFrame, ProjectRenderError> {
        self.pending = None;
        if self.poisoned || frame.composition_id != self.audio.composition_id {
            return Err(ProjectRenderError::Invalid(
                "native project session is not ready for this composition".into(),
            ));
        }
        let result = self.prepare_frame(frame, settings, inputs, cancellation, acquire_rasters);
        match &result {
            Ok(prepared) => self.pending = Some(prepared.generation),
            Err(_) => self.poisoned = true,
        }
        result
    }

    fn prepare_frame(
        &mut self,
        frame: &FramePlanRequest,
        settings: &ProjectFrameSettings,
        inputs: Option<inputs::PreparedProjectInputs>,
        cancellation: &CancellationToken,
        acquire_rasters: impl FnOnce(
            &ProjectResourceRequests,
        ) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<PreparedProjectFrame, ProjectRenderError> {
        let started = Instant::now();
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if settings.shadow_map_size == 0 || settings.shadow_map_size > 4096 {
            return Err(ProjectRenderError::Invalid(
                "invalid frame target preferences".into(),
            ));
        }
        let mut context = settings.resources.clone();
        // Diagnostic fallback must precede text exposure and geometry evaluation.
        if !matches!(
            context.visualization,
            BufferVisualization::Beauty
                | BufferVisualization::LinearColor
                | BufferVisualization::Luminance
                | BufferVisualization::Alpha
        ) {
            let requests = self.files.document.resource_requests(frame, &context)?;
            self.gpu
                .begin(&requests, None, context.surface.memory_budget_mb)?;
            context.visualization = self.gpu.configure_visualization(context.visualization)?;
        }
        let (inputs, prefetched_ms) = match inputs {
            Some(inputs) => {
                let elapsed = inputs.timings.total_ms;
                (inputs, elapsed)
            }
            None => (
                self.acquire_inputs(frame, &context, cancellation, acquire_rasters)?,
                0.0,
            ),
        };
        let inputs::PreparedProjectInputs {
            mut files,
            text:
                crate::ProjectTextFrame {
                    rasters,
                    native: native_text,
                    routes: text_routes,
                },
            mut timings,
        } = inputs;
        let limits = self.files.document.limits.clone();
        let phase = Instant::now();
        let materials = self.materials.acquire(
            &self.files.document,
            &frame.composition_id,
            frame.time,
            cancellation,
        )?;
        timings.materials_ms = phase.elapsed().as_secs_f64() * 1000.0;
        let phase = Instant::now();
        let audio = if self.analyze_audio {
            Some(
                self.audio
                    .analysis_frame(frame.time, cancellation)?
                    .into_iter()
                    .map(f32::to_bits)
                    .collect::<Vec<_>>(),
            )
        } else {
            None
        };
        timings.audio_ms = phase.elapsed().as_secs_f64() * 1000.0;
        let phase = Instant::now();
        let device = self.gpu.begin(
            &files.requests,
            audio.as_deref(),
            context.surface.memory_budget_mb,
        )?;
        timings.gpu_setup_ms = phase.elapsed().as_secs_f64() * 1000.0;
        let phase = Instant::now();
        for (id, hash) in rasters.bindings {
            if files.bindings.insert(id, hash).is_some() {
                return Err(ProjectRenderError::Invalid(
                    "file and raster instance bindings overlap".into(),
                ));
            }
        }
        files.resources.extend(rasters.resources);
        files.resources.extend(materials.resources);
        let file_pixels = std::mem::take(&mut files.pixels);
        files.pixels.extend(rasters.pixels);
        let mut unique = BTreeSet::new();
        let pixel_bytes = files
            .pixels
            .iter()
            .map(|p| &p.pixels)
            .chain(file_pixels.iter().map(|p| &p.pixels))
            .chain(materials.decoded.iter().map(|p| &p.pixels))
            .filter(|p| unique.insert(p.request().hash.clone()))
            .try_fold(0_usize, |total, p| total.checked_add(p.bytes().len()))
            .ok_or_else(|| ProjectRenderError::Invalid("frame pixel byte overflow".into()))?;
        if pixel_bytes > limits.render_project_pixel_bytes {
            return Err(ProjectRenderError::Invalid(
                "combined frame pixels exceed budget".into(),
            ));
        }
        let mut descriptor_budget = aster_eval::BundleResources::new(limits.bundle.clone())?;
        for packet in &files.resources {
            if !unique.contains(&packet.request().hash) {
                descriptor_budget.add(packet.clone())?;
            }
        }
        let scene = FrameSceneInputs {
            visualization: context.visualization,
            text_bounds: rasters.text_bounds,
            motion_text_bounds: rasters.motion_text_bounds,
            text_layouts: context.layouts.clone(),
            locale: context.locale.clone(),
        };
        let output = FrameOutputContext {
            visualization: context.visualization,
            beauty_depth_of_field: false,
            beauty_motion_blur: false,
            motion_blur_requested: false,
            selected_layer_id: settings.selected_layer_id.clone(),
            generator_selection_ids: Vec::new(),
            auxiliary_generators: Vec::new(),
            auxiliary_budget: AuxiliaryBudget {
                enabled: false,
                depth_available: false,
                tier: -1,
                estimated_bytes: 0,
                id_buffer_bytes: 0,
                motion_buffer_bytes: 0,
                byte_budget: 0,
            },
            motion_resources_available: false,
            motion_binding_available: false,
            depth_settings: DepthSettings::default(),
            depth_attachments: DepthAttachments::default(),
            surface_resources_available: false,
        };
        let resources = ProjectFrameResources {
            media: files.bindings,
            materials: Some(materials.bindings),
            packets: files.resources,
            pixels: files.pixels,
            temporal: rasters.temporal,
            audio,
            generator_device: device,
            surface_request: context.surface,
            surface_limits: limits.surfaces,
            output,
            effect_mip_levels: (frame
                .render_target
                .width
                .max(frame.render_target.height)
                .div_ceil(2)
                .max(1)
                .ilog2()
                + 1)
            .min(8),
            shadow_map_size: settings.shadow_map_size,
        };
        let mut budget = limits.bundle;
        budget.max_bundle_bytes = budget
            .max_bundle_bytes
            .checked_add(limits.render_project_pixel_bytes)
            .ok_or_else(|| {
                ProjectRenderError::Invalid("combined resource budget overflow".into())
            })?;
        timings.plan_inputs_ms = phase.elapsed().as_secs_f64() * 1000.0;
        let phase = Instant::now();
        let bundle = self.files.document.scene.plan_project_frame_allocated(
            frame,
            &scene,
            resources,
            &self.catalog,
            budget.clone(),
            &mut self.gpu,
        )?;
        timings.plan_ms = phase.elapsed().as_secs_f64() * 1000.0;
        let phase = Instant::now();
        let mut registry = ResourceRegistry::new(ResourceLimits {
            budget_bytes: budget.max_bundle_bytes as u64,
            max_resources: budget.max_bundle_resources,
            ..Default::default()
        })?;
        let mut packets = bundle.resources.clone();
        packets.sort_by_key(|packet| match packet.request().kind {
            ResourceKind::MediaSource => 0,
            ResourceKind::MediaFrame => 2,
            ResourceKind::RasterPixels => 3,
            _ => 1,
        });
        for packet in packets {
            registry.put_verified(packet)?;
        }
        let mut decoded_images = Vec::new();
        for pixels in file_pixels {
            if registry.descriptor(&pixels.frame).is_ok() {
                decoded_images.push(PrecompositionMediaPixels {
                    frame: pixels.frame,
                    pixels: pixels.pixels.request().hash.clone(),
                });
                registry.put_verified(pixels.pixels)?;
            }
        }
        let mut decoded = Vec::new();
        for pixels in materials.decoded {
            if registry.descriptor(&pixels.encoded).is_ok() {
                decoded.push(DecodedTexturePixels {
                    encoded: pixels.encoded,
                    pixels: pixels.pixels.request().hash.clone(),
                });
                registry.put_verified(pixels.pixels)?;
            }
        }
        let decode_limits = DecodeLimits::default();
        let plan = bundle.plan.encode_owned(&decode_limits)?;
        let supplied = SuppliedFrame::with_native_glyphs(
            plan,
            &registry,
            &decode_limits,
            &decoded_images,
            &decoded,
            native_text.clone(),
        )?;
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        self.generation = self.generation.checked_add(1).ok_or_else(|| {
            ProjectRenderError::Invalid("project frame generation exhausted".into())
        })?;
        timings.admission_ms = phase.elapsed().as_secs_f64() * 1000.0;
        timings.total_ms = prefetched_ms + started.elapsed().as_secs_f64() * 1000.0;
        Ok(PreparedProjectFrame {
            timings,
            bundle,
            frame: supplied,
            registry,
            decoded_images,
            text_routes,
            native_text,
            generation: self.generation,
            owner: Arc::clone(&self.owner),
        })
    }

    pub fn render(
        &mut self,
        frame: &PreparedProjectFrame,
        cancellation: &CancellationToken,
    ) -> Result<RenderedFrame, ProjectRenderError> {
        if self.poisoned
            || self.pending != Some(frame.generation)
            || !Arc::ptr_eq(&self.owner, &frame.owner)
        {
            return Err(ProjectRenderError::Invalid(
                "prepared project frame is stale or already submitted".into(),
            ));
        }
        self.pending = None;
        if cancellation.is_cancelled() {
            self.poisoned = true;
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        self.gpu
            .renderer
            .render(&frame.frame, &frame.registry)
            .map_err(|error| {
                self.poisoned = true;
                error.into()
            })
    }
}

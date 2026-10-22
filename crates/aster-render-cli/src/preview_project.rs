use crate::{
    ir::IrArgs,
    preview_transport::{
        PreviewDescription, PreviewFrameTimings, PreviewProducedFrame, PreviewProducer,
        PreviewSource, PreviewTransportArgs,
    },
    project_runtime::ProjectRuntimeArgs,
};
use aster_eval::FramePlanRequest;
use aster_render_ir::DecodeLimits;
use aster_render_project::{
    NativeProjectDocument, NativeProjectSession, NativeRasterProvider, ProjectFrameSettings,
    ProjectRasterFrame, RasterProviderOptions,
};
use aster_renderer::NativeRenderer;
use aster_video::CancellationToken;
use clap::Args;
use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    process::ExitCode,
    time::Instant,
};

#[derive(Debug, Args)]
pub(crate) struct PreviewProjectArgs {
    #[arg(long)]
    project: PathBuf,
    /// Immutable composition identity, target, rendering settings and optional retained raster host.
    #[arg(long)]
    request: PathBuf,
    #[arg(long, default_value_t = 4096)]
    max_preview_plugins: usize,
    #[command(flatten)]
    transport: PreviewTransportArgs,
    #[command(flatten)]
    runtime: ProjectRuntimeArgs,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewConfiguration {
    frame: FramePlanRequest,
    settings: ProjectFrameSettings,
    #[serde(default)]
    plugins: Vec<PathBuf>,
    #[serde(rename = "rasterProvider")]
    raster_provider: Option<RasterProviderOptions>,
}

struct ProjectPreviewState {
    session: NativeProjectSession,
    configuration: PreviewConfiguration,
    provider: Option<NativeRasterProvider>,
    description: PreviewDescription,
}

struct PreviewProjectSession {
    runtime: ProjectRuntimeArgs,
    max_plugins: usize,
    slots: u32,
    state: Option<ProjectPreviewState>,
    cancellation: CancellationToken,
}

impl PreviewProjectArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        let mut producer = PreviewProjectSession {
            runtime: self.runtime,
            max_plugins: self.max_preview_plugins,
            slots: self.transport.slots,
            state: None,
            cancellation: CancellationToken::default(),
        };
        producer.replace(&self.project, &self.request)?;
        let result = self.transport.serve(&mut producer);
        if let Some(state) = &mut producer.state {
            state.session.gpu.renderer.release_shared_preview()?;
        }
        result
    }
}

impl PreviewProjectSession {
    fn open(
        &self,
        project: &Path,
        mut configuration: PreviewConfiguration,
        renderer: Option<NativeRenderer>,
    ) -> Result<ProjectPreviewState, Box<dyn std::error::Error>> {
        let document = NativeProjectDocument::open(project, self.runtime.project.clone())?;
        let provider = configuration
            .raster_provider
            .take()
            .map(|options| {
                NativeRasterProvider::start(
                    options,
                    project,
                    &document.authored_sha256,
                    self.runtime.project.clone(),
                    &self.cancellation,
                )
            })
            .transpose()?;
        if let Some(provider) = &provider {
            configuration.settings.resources.locale = provider.ready.locale.clone();
            configuration.settings.resources.layouts = provider.ready.layouts.clone();
            configuration.settings.resources.maximum_raster_dimension = configuration
                .settings
                .resources
                .maximum_raster_dimension
                .min(provider.ready.maximum_dimension);
        }
        let (mut session, identity) = self.runtime.open_preview(
            document,
            &configuration.frame,
            &configuration.settings,
            &configuration.plugins,
            renderer,
            &self.cancellation,
        )?;
        let size = configuration.frame.target;
        session
            .gpu
            .renderer
            .prepare_shared_preview(size, self.slots)?;
        let description = PreviewDescription {
            adapter: session.gpu.renderer.diagnostics.clone(),
            width: size.width,
            height: size.height,
            source: PreviewSource::Project {
                authored_sha256: identity.authored_sha256,
                runtime_sha256: identity.runtime_sha256,
                scope: configuration.frame.snapshot_scope.clone(),
                revision: configuration.frame.project_revision,
                composition_id: configuration.frame.composition_id.clone(),
            },
        };
        Ok(ProjectPreviewState {
            session,
            configuration,
            provider,
            description,
        })
    }
}

impl PreviewProducer for PreviewProjectSession {
    fn describe(&self) -> Result<PreviewDescription, Box<dyn std::error::Error>> {
        Ok(self
            .state
            .as_ref()
            .ok_or("preview snapshot is not open")?
            .description
            .clone())
    }

    fn replace(
        &mut self,
        project: &Path,
        request: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let limits = DecodeLimits {
            max_container_bytes: self.runtime.project.render_project_input_bytes,
            ..DecodeLimits::default()
        };
        if !(32..=67_108_864).contains(&limits.max_container_bytes) {
            return Err("invalid preview configuration budget".into());
        }
        let configuration: PreviewConfiguration =
            serde_json::from_slice(&IrArgs::read_bounded(request, &limits)?)?;
        if self.max_plugins > 4096 || configuration.plugins.len() > self.max_plugins {
            return Err("preview plugin count exceeds limit".into());
        }
        let renderer = match self.state.take() {
            Some(state) if state.configuration.frame.target == configuration.frame.target => {
                // Drained same-size snapshots retain the device, shader caches and shared pool.
                Some(state.session.gpu.renderer)
            }
            // Resizing retires the entire old allocation generation before admitting a new one.
            _ => None,
        };
        self.state = Some(self.open(project, configuration, renderer)?);
        Ok(())
    }

    fn render(
        &mut self,
        time: Option<f64>,
    ) -> Result<PreviewProducedFrame, Box<dyn std::error::Error>> {
        let state = self.state.as_mut().ok_or("preview snapshot is not open")?;
        let mut frame = state.configuration.frame.clone();
        frame.time = time.ok_or("project preview requires an explicit time")?;
        let started = Instant::now();
        let mut raster_ms = 0.0;
        let prepared = state.session.prepare(
            &frame,
            &state.configuration.settings,
            &self.cancellation,
            |requests| {
                let raster_started = Instant::now();
                let result = match &mut state.provider {
                    Some(provider) => provider.acquire(requests, &self.cancellation),
                    None => Ok(ProjectRasterFrame::default()),
                };
                raster_ms = raster_started.elapsed().as_secs_f64() * 1000.0;
                result
            },
        )?;
        let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let rendered = state.session.render(&prepared, &self.cancellation)?;
        let render_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let surface = state.session.gpu.renderer.share_preview(&rendered)?;
        Ok(PreviewProducedFrame {
            surface,
            timings: Some(PreviewFrameTimings {
                prepare_ms,
                raster_ms,
                render_ms,
                share_ms: started.elapsed().as_secs_f64() * 1000.0,
            }),
        })
    }
}

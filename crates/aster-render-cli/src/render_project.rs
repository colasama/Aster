use crate::{
    ir::IrArgs,
    project_capture::ProjectCapture,
    project_runtime::{ProjectIdentity, ProjectRuntimeArgs},
};
use aster_eval::FramePlanRequest;
use aster_render::AdapterDiagnostics;
use aster_render_compare::image::RgbaImage;
use aster_render_ir::DecodeLimits;
use aster_render_project::{
    NativeProjectDocument, NativeRasterProvider, ProjectFrameSettings, ProjectRasterFrame,
    RasterProviderOptions,
};
use aster_video::CancellationToken;
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, path::PathBuf, process::ExitCode, time::Instant};

#[derive(Debug, Args)]
pub(crate) struct RenderProjectArgs {
    #[arg(long, required_unless_present = "batch", conflicts_with = "batch")]
    project: Option<PathBuf>,
    /// Bounded frame addresses and raster-provider settings; no supplied plans are accepted.
    #[arg(long, required_unless_present = "batch", conflicts_with = "batch")]
    request: Option<PathBuf>,
    #[arg(long, required_unless_present = "batch", conflicts_with = "batch")]
    out: Option<PathBuf>,
    /// JSON jobs with project, request and new output directory; one retained GPU executes them.
    #[arg(long)]
    batch: Option<PathBuf>,
    #[arg(long, default_value_t = 4096)]
    max_project_jobs: usize,
    #[arg(long, default_value_t = 1_073_741_824)]
    capture_output_bytes: u64,
    #[command(flatten)]
    runtime: ProjectRuntimeArgs,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectJob {
    project: PathBuf,
    request: PathBuf,
    out: PathBuf,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrameInput {
    frame: FramePlanRequest,
    rasters: Option<PathBuf>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectRequest {
    settings: ProjectFrameSettings,
    frames: Vec<FrameInput>,
    #[serde(default)]
    plugins: Vec<PathBuf>,
    #[serde(rename = "rasterProvider")]
    raster_provider: Option<RasterProviderOptions>,
}

#[derive(Serialize)]
struct ProjectReport {
    schema_version: u32,
    kind: &'static str,
    status: &'static str,
    diagnostic_readback: bool,
    raster_mode: &'static str,
    project: ProjectIdentity,
    request_sha256: String,
    adapter: AdapterDiagnostics,
    frames: Vec<crate::project_capture::FrameReceipt>,
}

impl RenderProjectArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        let read_limits = DecodeLimits {
            max_container_bytes: self.runtime.project.render_project_input_bytes,
            ..DecodeLimits::default()
        };
        if !(32..=67_108_864).contains(&read_limits.max_container_bytes)
            || self.max_project_jobs == 0
            || self.max_project_jobs > 4096
        {
            return Err("invalid project request admission limits".into());
        }
        let jobs: Vec<ProjectJob> = if let Some(path) = self.batch {
            serde_json::from_slice(&IrArgs::read_bounded(&path, &read_limits)?)?
        } else {
            vec![ProjectJob {
                project: self.project.ok_or("project absent")?,
                request: self.request.ok_or("request absent")?,
                out: self.out.ok_or("output absent")?,
            }]
        };
        if jobs.is_empty() || jobs.len() > self.max_project_jobs {
            return Err("project job count exceeds limit".into());
        }
        let mut destinations = BTreeSet::new();
        for job in &jobs {
            let path = std::path::absolute(&job.out)?;
            if path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
                || path.try_exists()?
            {
                return Err("capture output must be a new path without parent traversal".into());
            }
            let key = if cfg!(windows) {
                path.to_string_lossy().to_lowercase()
            } else {
                path.to_string_lossy().into_owned()
            };
            if !destinations.insert(key) {
                return Err("duplicate project output destination".into());
            }
        }
        let cancellation = CancellationToken::default();
        let mut renderer = None;
        for job in jobs {
            let bytes = IrArgs::read_bounded(&job.request, &read_limits)?;
            let mut request: ProjectRequest = serde_json::from_slice(&bytes)?;
            if request.frames.is_empty()
                || request.frames.len() > self.runtime.project.render_project_frames
                || request.plugins.len() > 4096
            {
                return Err("project frame or plugin count exceeds limit".into());
            }
            if request.raster_provider.is_some()
                && request.frames.iter().any(|frame| frame.rasters.is_some())
            {
                return Err("live raster provider cannot use supplied raster manifests".into());
            }
            let document = NativeProjectDocument::open(&job.project, self.runtime.project.clone())?;
            let mut provider = request
                .raster_provider
                .take()
                .map(|options| {
                    NativeRasterProvider::start(
                        options,
                        &job.project,
                        &document.authored_sha256,
                        self.runtime.project.clone(),
                        &cancellation,
                    )
                })
                .transpose()?;
            if let Some(provider) = &provider {
                request.settings.resources.locale = provider.ready.locale.clone();
                request.settings.resources.layouts = provider.ready.layouts.clone();
                request.settings.resources.maximum_raster_dimension = request
                    .settings
                    .resources
                    .maximum_raster_dimension
                    .min(provider.ready.maximum_dimension);
            }
            let frames = request
                .frames
                .iter()
                .map(|f| f.frame.clone())
                .collect::<Vec<_>>();
            let (mut session, identity) = self.runtime.open(
                document,
                &frames,
                &request.settings,
                &request.plugins,
                renderer.take(),
                &cancellation,
            )?;
            let mut capture = ProjectCapture::new(&job.out, self.capture_output_bytes)?;
            capture.write(std::path::Path::new("request.json"), &bytes)?;
            let mut report = ProjectReport {
                schema_version: 1,
                kind: "native-project-render",
                status: "passed",
                diagnostic_readback: true,
                raster_mode: if provider.is_some() {
                    "live"
                } else {
                    "supplied"
                },
                project: identity,
                request_sha256: format!("{:x}", Sha256::digest(&bytes)),
                adapter: session.gpu.renderer.diagnostics.clone(),
                frames: Vec::new(),
            };
            for (index, input) in request.frames.iter().enumerate() {
                let started = Instant::now();
                let mut raster_request_sha256 = None;
                let prepared = session.prepare(
                    &input.frame,
                    &request.settings,
                    &cancellation,
                    |requests| {
                        raster_request_sha256 = Some(format!(
                            "{:x}",
                            Sha256::digest(serde_json::to_vec(requests)?)
                        ));
                        match (&mut provider, &input.rasters) {
                            (Some(provider), _) => provider.acquire(requests, &cancellation),
                            (None, Some(path)) => ProjectRasterFrame::load(
                                path,
                                requests,
                                &self.runtime.project,
                                &cancellation,
                            ),
                            (None, None) => Ok(ProjectRasterFrame::default()),
                        }
                    },
                )?;
                let rendered = session.render(&prepared, &cancellation)?;
                let pixels = session.gpu.renderer.read_rgba(&rendered)?;
                let image = RgbaImage::new(rendered.size.width, rendered.size.height, pixels)?;
                let mut receipt = capture.frame(index, &prepared, &image, &session.gpu.renderer)?;
                receipt.duration_ms = started.elapsed().as_millis();
                receipt.raster_request_sha256 = raster_request_sha256;
                report.frames.push(receipt);
            }
            let report_bytes = serde_json::to_vec(&report)?;
            capture.write(std::path::Path::new("report.json"), &report_bytes)?;
            capture.finish()?;
            println!("{}", String::from_utf8(report_bytes)?);
            renderer = Some(session.gpu.renderer);
        }
        Ok(ExitCode::SUCCESS)
    }
}

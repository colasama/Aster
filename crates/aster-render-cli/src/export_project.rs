use crate::{ir::IrArgs, project_runtime::ProjectRuntimeArgs};
use aster_encode::EncoderOptions;
use aster_eval::{BufferVisualization, ResourceRequestContext, SurfaceRequest};
use aster_render_ir::{AntiAliasing, DecodeLimits, Extent2d, RationalFrameRate};
use aster_render_project::{
    NativeProjectDocument, NativeProjectExport, NativeProjectImageExport, NativeRasterProvider,
    ProjectExportControl, ProjectExportFormat, ProjectExportSettings, ProjectFrameSettings,
    RasterProviderOptions,
};
use aster_video::ExportLimits;
use clap::Args;
use serde::{Deserialize, Serialize};
use std::{
    io::{BufRead, Read},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Debug, Args)]
pub(crate) struct ExportProjectArgs {
    #[arg(long)]
    project: PathBuf,
    #[arg(long)]
    composition: String,
    #[arg(long)]
    out: PathBuf,
    #[arg(long, value_enum, default_value = "mp4")]
    format: ProjectExportFormat,
    /// Aggregate PNG output bound; a sequence is published only after every frame succeeds.
    #[arg(long, default_value_t = 4_294_967_296)]
    image_output_bytes: u64,
    /// Optional raster-provider, font/surface settings and installed plugin paths; no frame plans.
    #[arg(long)]
    request: Option<PathBuf>,
    #[arg(long, conflicts_with = "start_frame")]
    start: Option<f64>,
    /// Absolute composition frame index, evaluated directly through the output rational rate.
    #[arg(long, conflicts_with = "start")]
    start_frame: Option<u64>,
    #[arg(long)]
    frames: Option<u64>,
    #[arg(long, requires = "height")]
    width: Option<u32>,
    #[arg(long, requires = "width")]
    height: Option<u32>,
    #[arg(long, requires = "fps_denominator")]
    fps_numerator: Option<u32>,
    #[arg(long, requires = "fps_numerator")]
    fps_denominator: Option<u32>,
    #[arg(long, default_value_t = 20_000_000)]
    bitrate: u32,
    /// Omit the output audio track while retaining audio inputs for visual evaluation.
    #[arg(long)]
    no_audio: bool,
    #[arg(long,default_value="off",value_parser=["off","fxaa","ssaa2x","ssaa4x"])]
    aa: String,
    /// Receive newline-delimited pause/resume/cancel controls; pause may carry a request_id.
    #[arg(long)]
    control_stdin: bool,
    /// Optional atomic capture of selected native pre-encode frames for verification.
    #[arg(long, requires = "witness_frames")]
    witness: Option<PathBuf>,
    #[arg(long, value_delimiter = ',', requires = "witness")]
    witness_frames: Vec<u64>,
    #[arg(long, default_value_t = 536_870_912)]
    witness_bytes: u64,
    #[command(flatten)]
    runtime: ProjectRuntimeArgs,
    #[command(flatten)]
    encoder: EncoderOptions,
    #[command(flatten)]
    mux: ExportLimits,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExportConfiguration {
    settings: Option<ProjectFrameSettings>,
    raster_provider: Option<RasterProviderOptions>,
    #[serde(default)]
    plugins: Vec<PathBuf>,
    #[serde(default)]
    unavailable_generators: Vec<aster_eval::UnavailableGenerator>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
enum Control {
    Pause {
        #[serde(default)]
        request_id: Option<u64>,
    },
    Resume,
    Cancel,
}

#[derive(Serialize)]
struct PauseReceipt {
    stage: &'static str,
    request_id: Option<u64>,
}

#[derive(Serialize)]
struct ExportReceipt {
    schema_version: u32,
    status: &'static str,
    project: crate::project_runtime::ProjectIdentity,
    adapter: aster_render::AdapterDiagnostics,
    video: aster_render_ir::ExportVideoConfig,
    report: aster_render_project::ProjectExportReport,
    witness: Option<crate::export_witness::WitnessReceipt>,
}

#[derive(Serialize)]
struct ImageExportReceipt {
    schema_version: u32,
    status: &'static str,
    format: ProjectExportFormat,
    project: crate::project_runtime::ProjectIdentity,
    adapter: aster_render::AdapterDiagnostics,
    size: Extent2d,
    frame_rate: RationalFrameRate,
    output: PathBuf,
    report: aster_render_project::ProjectImageExportReport,
    images: Vec<crate::export_images::PngFrameReceipt>,
}

impl ExportProjectArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        if self.out.try_exists()? {
            return Err("export destination already exists".into());
        }
        if self.format != ProjectExportFormat::Mp4 && self.witness.is_some() {
            return Err("PNG exports do not use video encoder witnesses".into());
        }
        let control = ProjectExportControl::default().with_pause_observer(|request_id| {
            if let Ok(message) = serde_json::to_string(&PauseReceipt {
                stage: "paused",
                request_id,
            }) {
                println!("{message}");
            }
        });
        if self.control_stdin {
            let reader = control.clone();
            std::thread::spawn(move || {
                let result = (|| -> Result<(), Box<dyn std::error::Error>> {
                    let mut input = std::io::stdin().lock();
                    loop {
                        let mut line = Vec::new();
                        let count = Read::by_ref(&mut input)
                            .take(1025)
                            .read_until(b'\n', &mut line)?;
                        if count == 0 {
                            reader.cancellation.cancel();
                            return Ok(());
                        }
                        if count > 1024 || !line.ends_with(b"\n") {
                            return Err("invalid export control length".into());
                        }
                        match serde_json::from_slice::<Control>(&line)? {
                            Control::Pause { request_id } => reader.pause(true, request_id)?,
                            Control::Resume => reader.pause(false, None)?,
                            Control::Cancel => {
                                reader.cancellation.cancel();
                                return Ok(());
                            }
                        }
                    }
                })();
                if result.is_err() {
                    reader.cancellation.cancel();
                }
            });
        }
        let configuration: ExportConfiguration = match self.request {
            Some(path) => serde_json::from_slice(&IrArgs::read_bounded(
                &path,
                &DecodeLimits {
                    max_container_bytes: self.runtime.project.render_project_input_bytes,
                    ..Default::default()
                },
            )?)?,
            None => ExportConfiguration::default(),
        };
        if configuration.plugins.len() > 4096 {
            return Err("plugin count exceeds export limit".into());
        }
        let document = NativeProjectDocument::open(&self.project, self.runtime.project.clone())?;
        let schedule = document.export_schedule(ProjectExportSettings {
            format: self.format,
            composition: self.composition,
            start_time: self.start.unwrap_or(0.),
            start_frame: self.start_frame,
            frame_count: self
                .frames
                .or((self.format == ProjectExportFormat::Png).then_some(1)),
            size: self
                .width
                .zip(self.height)
                .map(|(width, height)| Extent2d { width, height }),
            frame_rate: self.fps_numerator.zip(self.fps_denominator).map(
                |(numerator, denominator)| RationalFrameRate {
                    numerator,
                    denominator,
                },
            ),
            bitrate_bps: self.bitrate,
            anti_aliasing: match self.aa.as_str() {
                "fxaa" => AntiAliasing::Fxaa,
                "ssaa2x" => AntiAliasing::Ssaa2x,
                "ssaa4x" => AntiAliasing::Ssaa4x,
                _ => AntiAliasing::Off,
            },
        })?;
        let image_output = if self.format != ProjectExportFormat::Mp4 {
            Some(crate::export_images::PngOutput::new(
                self.out.clone(),
                self.format,
                schedule.video.size,
                schedule.frames.len() as u64,
                self.image_output_bytes,
            )?)
        } else {
            None
        };
        let mut settings = configuration.settings.unwrap_or(ProjectFrameSettings {
            resources: ResourceRequestContext {
                visualization: BufferVisualization::Beauty,
                locale: "en-US".into(),
                layouts: Default::default(),
                surface: SurfaceRequest {
                    revision: 1,
                    max_texture_dimension: 4096,
                    memory_budget_mb: Some(512.),
                    render_scale: 1.,
                },
                maximum_raster_dimension: 8192,
                maximum_raster_pixels: 67_108_864,
            },
            selected_layer_id: None,
            shadow_map_size: 1024,
        });
        if let Some(first) = schedule.frames.first() {
            settings.resources.surface.render_scale =
                f64::from(first.render_target.width) / f64::from(first.target.width);
        }
        let provider = configuration
            .raster_provider
            .map(|options| {
                NativeRasterProvider::start(
                    options,
                    &self.project,
                    &document.authored_sha256,
                    self.runtime.project.clone(),
                    &control.cancellation,
                )
            })
            .transpose()?;
        if let Some(provider) = &provider {
            settings.resources.locale = provider.ready.locale.clone();
            settings.resources.layouts = provider.ready.layouts.clone();
            settings.resources.maximum_raster_dimension = settings
                .resources
                .maximum_raster_dimension
                .min(provider.ready.maximum_dimension);
        }
        control.wait()?;
        let (session, identity) = self.runtime.open_schedule(
            document,
            crate::project_runtime::ProjectScheduleAdmission {
                frames: schedule.frames.clone(),
                unavailable_generators: configuration.unavailable_generators,
            },
            &settings,
            &configuration.plugins,
            None,
            &control.cancellation,
        )?;
        let video = schedule.video.clone();
        let adapter = session.gpu.renderer.diagnostics.clone();
        if let Some(mut output) = image_output {
            let report = NativeProjectImageExport {
                session,
                schedule,
                settings,
                raster_provider: provider,
                control,
            }
            .run(&mut output, |progress| {
                if let Ok(message) = serde_json::to_string(&progress) {
                    println!("{message}");
                }
            })?;
            println!(
                "{}",
                serde_json::to_string(&ImageExportReceipt {
                    schema_version: 1,
                    status: "passed",
                    format: self.format,
                    project: identity,
                    adapter,
                    size: video.size,
                    frame_rate: video.frame_rate,
                    output: self.out,
                    report,
                    images: std::mem::take(&mut output.frames),
                })?
            );
            return Ok(ExitCode::SUCCESS);
        }
        let mut witness = self
            .witness
            .as_ref()
            .map(|path| {
                crate::export_witness::ExportWitness::new(
                    path,
                    self.witness_frames,
                    schedule.frames.len() as u64,
                    self.witness_bytes,
                )
            })
            .transpose()?;
        let report = NativeProjectExport {
            session,
            schedule,
            settings,
            raster_provider: provider,
            include_audio: !self.no_audio,
            encoder_options: self.encoder,
            mux_limits: self.mux,
            ffmpeg: self.runtime.ffmpeg,
            output: self.out,
            control,
        }
        .run(
            |progress| {
                if let Ok(message) = serde_json::to_string(&progress) {
                    println!("{message}");
                }
            },
            witness
                .as_mut()
                .map(|witness| witness as &mut dyn aster_render_project::ProjectExportObserver),
        )?;
        let witness = witness
            .map(|witness| witness.finish(&report, &identity, &video, &adapter))
            .transpose()?;
        println!(
            "{}",
            serde_json::to_string(&ExportReceipt {
                schema_version: 1,
                status: "passed",
                project: identity,
                adapter,
                video,
                report,
                witness,
            })?
        );
        Ok(ExitCode::SUCCESS)
    }
}

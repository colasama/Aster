use aster_eval::FramePlanRequest;
use aster_media_native::{ProjectMediaLimits, ProjectMediaTools, RadianceLimits, TextureLimits};
use aster_render::NativeBackend;
use aster_render_project::{
    NativeProjectAudio, NativeProjectDocument, NativeProjectFileMedia, NativeProjectGenerators,
    NativeProjectGpu, NativeProjectMaterials, NativeProjectSession, ProjectAudioLimits,
    ProjectFrameSettings, ProjectRenderLimits,
};
use aster_renderer::{NativeOptions, NativeRenderer};
use aster_video::CancellationToken;
use clap::Args;
use serde::Serialize;
use std::{path::PathBuf, time::Duration};

#[derive(Debug, Args)]
pub(crate) struct ProjectRuntimeArgs {
    #[arg(long)]
    pub ffmpeg: PathBuf,
    #[arg(long)]
    ffprobe: PathBuf,
    #[arg(long, default_value="auto", value_parser=["auto", "dx12", "vulkan", "metal"])]
    backend: String,
    #[arg(long)]
    adapter: Option<String>,
    #[arg(long)]
    dxcompiler: Option<PathBuf>,
    #[arg(long, default_value_t = 536_870_912)]
    gpu_budget_bytes: u64,
    #[arg(long, default_value_t = 67_108_864)]
    layer_cache_bytes: u64,
    #[arg(long, default_value_t = 16)]
    effect_pipeline_entries: usize,
    #[arg(long, default_value_t = 30_000)]
    timeout_ms: u64,
    #[command(flatten)]
    pub project: ProjectRenderLimits,
    #[command(flatten)]
    media: ProjectMediaLimits,
    #[command(flatten)]
    audio: ProjectAudioLimits,
    #[command(flatten)]
    textures: TextureLimits,
    #[command(flatten)]
    radiance: RadianceLimits,
}

#[derive(Serialize)]
pub(crate) struct ProjectIdentity {
    pub authored_sha256: String,
    pub runtime_sha256: String,
}

enum ProjectAdmission {
    Schedule(ProjectScheduleAdmission),
    #[cfg(windows)]
    Preview(ProjectPreviewAdmission),
}

pub(crate) struct ProjectScheduleAdmission {
    pub frames: Vec<FramePlanRequest>,
    pub unavailable_generators: Vec<aster_eval::UnavailableGenerator>,
}

#[cfg(windows)]
pub(crate) struct ProjectPreviewAdmission {
    pub frame: FramePlanRequest,
    pub unavailable_generators: Vec<aster_eval::UnavailableGenerator>,
}

impl ProjectRuntimeArgs {
    pub fn open(
        &self,
        document: NativeProjectDocument,
        frames: &[FramePlanRequest],
        settings: &ProjectFrameSettings,
        plugins: &[PathBuf],
        renderer: Option<NativeRenderer>,
        cancellation: &CancellationToken,
    ) -> Result<(NativeProjectSession, ProjectIdentity), Box<dyn std::error::Error>> {
        self.open_admitted(
            document,
            ProjectAdmission::Schedule(ProjectScheduleAdmission {
                frames: frames.to_vec(),
                unavailable_generators: Vec::new(),
            }),
            settings,
            plugins,
            renderer,
            cancellation,
        )
    }

    pub fn open_schedule(
        &self,
        document: NativeProjectDocument,
        admission: ProjectScheduleAdmission,
        settings: &ProjectFrameSettings,
        plugins: &[PathBuf],
        renderer: Option<NativeRenderer>,
        cancellation: &CancellationToken,
    ) -> Result<(NativeProjectSession, ProjectIdentity), Box<dyn std::error::Error>> {
        self.open_admitted(
            document,
            ProjectAdmission::Schedule(admission),
            settings,
            plugins,
            renderer,
            cancellation,
        )
    }

    #[cfg(windows)]
    pub fn open_preview(
        &self,
        document: NativeProjectDocument,
        admission: ProjectPreviewAdmission,
        settings: &ProjectFrameSettings,
        plugins: &[PathBuf],
        renderer: Option<NativeRenderer>,
        cancellation: &CancellationToken,
    ) -> Result<(NativeProjectSession, ProjectIdentity), Box<dyn std::error::Error>> {
        self.open_admitted(
            document,
            ProjectAdmission::Preview(admission),
            settings,
            plugins,
            renderer,
            cancellation,
        )
    }

    fn open_admitted(
        &self,
        document: NativeProjectDocument,
        admission: ProjectAdmission,
        settings: &ProjectFrameSettings,
        plugins: &[PathBuf],
        renderer: Option<NativeRenderer>,
        cancellation: &CancellationToken,
    ) -> Result<(NativeProjectSession, ProjectIdentity), Box<dyn std::error::Error>> {
        let frames = match &admission {
            ProjectAdmission::Schedule(admission) => admission.frames.as_slice(),
            #[cfg(windows)]
            ProjectAdmission::Preview(admission) => std::slice::from_ref(&admission.frame),
        };
        let first = frames.first().ok_or("native project schedule is empty")?;
        if frames.iter().any(|frame| {
            frame.composition_id != first.composition_id
                || frame.snapshot_scope != first.snapshot_scope
                || frame.project_revision != first.project_revision
        }) {
            return Err("native project schedule changes composition or snapshot identity".into());
        }
        let identity = ProjectIdentity {
            authored_sha256: document.authored_sha256.clone(),
            runtime_sha256: document.runtime_sha256.clone(),
        };
        let tools = ProjectMediaTools {
            ffmpeg: self.ffmpeg.clone(),
            ffprobe: self.ffprobe.clone(),
        };
        let audio = NativeProjectAudio::new(
            &document,
            &first.composition_id,
            ProjectMediaTools {
                ffmpeg: self.ffmpeg.clone(),
                ffprobe: self.ffprobe.clone(),
            },
            self.audio.clone(),
            cancellation,
        )?;
        let files = match &admission {
            ProjectAdmission::Schedule(_) => NativeProjectFileMedia::new(
                document,
                frames,
                &settings.resources,
                tools,
                self.media.clone(),
                cancellation,
            )?,
            #[cfg(windows)]
            ProjectAdmission::Preview(admission) => NativeProjectFileMedia::new_preview(
                document,
                &admission.frame,
                &settings.resources,
                tools,
                self.media.clone(),
                cancellation,
            )?,
        };
        let materials = NativeProjectMaterials::new(
            self.ffmpeg.clone(),
            self.textures.clone(),
            self.radiance.clone(),
        )?;
        let installed = NativeProjectGenerators::load_installed(
            plugins,
            &settings.resources.locale,
            &Default::default(),
            &self.project.bundle,
        )?;
        let catalog = NativeProjectGenerators::catalog(installed, self.project.bundle.clone())?;
        let catalog = match &admission {
            #[cfg(windows)]
            ProjectAdmission::Preview(preview) => {
                catalog.with_unavailable(preview.unavailable_generators.clone())?
            }
            ProjectAdmission::Schedule(schedule) => {
                catalog.with_unavailable(schedule.unavailable_generators.clone())?
            }
        };
        let renderer = match renderer {
            Some(renderer) => renderer,
            None => {
                let backend = match self.backend.as_str() {
                    "dx12" => NativeBackend::Dx12,
                    "metal" => NativeBackend::Metal,
                    "vulkan" => NativeBackend::Vulkan,
                    _ if cfg!(target_os = "windows") => NativeBackend::Dx12,
                    _ if cfg!(target_os = "macos") => NativeBackend::Metal,
                    _ => NativeBackend::Vulkan,
                };
                NativeRenderer::new(NativeOptions {
                    backend,
                    adapter_name: self.adapter.clone(),
                    dxcompiler: self.dxcompiler.clone(),
                    gpu_budget_bytes: self.gpu_budget_bytes,
                    layer_cache_bytes: self.layer_cache_bytes,
                    effect_pipeline_entries: self.effect_pipeline_entries,
                    gpu_timestamps: false,
                    effect_regions: true,
                    timeout: Duration::from_millis(self.timeout_ms),
                })?
            }
        };
        Ok((
            NativeProjectSession::new(
                files,
                materials,
                audio,
                NativeProjectGpu::new(renderer),
                catalog,
            )?,
            identity,
        ))
    }
}

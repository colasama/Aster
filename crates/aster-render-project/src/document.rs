use crate::ProjectRenderError;
use aster_eval::{
    BundleLimits, EvaluationLimits, ExpressionLimits, FramePlanRequest, ProjectResourceRequests,
    ResourceRequestContext, SceneLimits, SceneProject, SurfaceLimits,
};
use aster_project::{
    MediaSourceLimits, ProjectMediaCatalog, ProjectMediaCatalogLimits, RuntimeProjectDocument,
    RuntimeProjectLimits,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, clap::Args)]
pub struct ProjectRenderLimits {
    #[arg(long, default_value_t = 67_108_864)]
    pub render_project_input_bytes: usize,
    #[arg(long, default_value_t = 4096)]
    pub render_project_frames: usize,
    #[arg(long, default_value_t = 268_435_456)]
    pub render_project_pixel_bytes: usize,
    #[command(flatten)]
    pub scene: SceneLimits,
    #[command(flatten)]
    pub surfaces: SurfaceLimits,
    #[command(flatten)]
    pub sources: MediaSourceLimits,
    #[command(flatten)]
    pub catalog: ProjectMediaCatalogLimits,
    #[command(flatten)]
    pub bundle: BundleLimits,
}

pub struct NativeProjectDocument {
    pub(crate) root: PathBuf,
    pub(crate) catalog: ProjectMediaCatalog,
    pub(crate) scene: SceneProject,
    pub(crate) limits: ProjectRenderLimits,
    pub authored_sha256: String,
    pub runtime_sha256: String,
}

impl NativeProjectDocument {
    pub fn open(path: &Path, limits: ProjectRenderLimits) -> Result<Self, ProjectRenderError> {
        if !(32..=67_108_864).contains(&limits.render_project_input_bytes)
            || limits.render_project_frames == 0
            || limits.render_project_frames > 65_536
            || limits.render_project_pixel_bytes == 0
            || limits.render_project_pixel_bytes > 1_073_741_824
        {
            return Err(ProjectRenderError::Invalid(
                "bounded project bytes and frame count required".into(),
            ));
        }
        let file = if path.is_dir() {
            path.join("project.json")
        } else {
            path.to_path_buf()
        }
        .canonicalize()?;
        let root = file
            .parent()
            .ok_or_else(|| ProjectRenderError::Invalid("project parent absent".into()))?
            .to_path_buf();
        let input = File::open(&file)?;
        if !input.metadata()?.is_file()
            || input.metadata()?.len() > limits.render_project_input_bytes as u64
        {
            return Err(ProjectRenderError::Invalid(
                "project exceeds byte budget".into(),
            ));
        }
        let mut bytes = Vec::new();
        input
            .take(limits.render_project_input_bytes as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limits.render_project_input_bytes {
            return Err(ProjectRenderError::Invalid(
                "project grew past byte budget".into(),
            ));
        }
        let runtime = RuntimeProjectDocument::from_slice(
            &bytes,
            &RuntimeProjectLimits {
                max_input_bytes: limits.render_project_input_bytes,
                max_output_bytes: limits.render_project_input_bytes,
                max_compositions: limits.scene.max_compositions,
                max_project_layers: limits.scene.max_project_layers,
            },
        )?
        .encode()?;
        Ok(Self {
            root,
            catalog: ProjectMediaCatalog::from_slice(&runtime, &limits.catalog)?,
            scene: SceneProject::compile_document(
                &runtime,
                &limits.scene,
                &EvaluationLimits::default(),
                &ExpressionLimits::default(),
            )?,
            authored_sha256: format!("{:x}", Sha256::digest(bytes)),
            runtime_sha256: format!("{:x}", Sha256::digest(runtime)),
            limits,
        })
    }

    pub fn resource_requests(
        &self,
        frame: &FramePlanRequest,
        context: &ResourceRequestContext,
    ) -> Result<ProjectResourceRequests, ProjectRenderError> {
        Ok(self
            .scene
            .project_resource_requests(frame, context, &self.limits.surfaces)?)
    }
}

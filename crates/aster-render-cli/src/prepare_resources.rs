use crate::ir::IrArgs;
use aster_eval::{
    EvaluationLimits, ExpressionLimits, FramePlanRequest, ProjectResourceRequests,
    ResourceRequestContext, SceneLimits, SceneProject, SurfaceLimits,
};
use aster_project::{RuntimeProjectDocument, RuntimeProjectLimits};
use aster_render_ir::DecodeLimits;
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf, process::ExitCode};

#[derive(Debug, Args)]
pub(crate) struct PrepareResourcesArgs {
    #[arg(long)]
    project: PathBuf,
    /// Frame address, font-provider layouts and bounded device capabilities.
    #[arg(long)]
    request: PathBuf,
    #[arg(long, default_value_t = 67_108_864)]
    max_input_bytes: usize,
    #[command(flatten)]
    scene_limits: SceneLimits,
    #[command(flatten)]
    surface_limits: SurfaceLimits,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    frame: FramePlanRequest,
    context: ResourceRequestContext,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    kind: &'static str,
    project_sha256: String,
    runtime_project_sha256: String,
    request_sha256: String,
    preparation_sha256: String,
    preparation: ProjectResourceRequests,
}

impl PrepareResourcesArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        if !(32..=67_108_864).contains(&self.max_input_bytes) {
            return Err("input byte limit must be between 32 and 67108864".into());
        }
        let limits = DecodeLimits {
            max_container_bytes: self.max_input_bytes,
            ..DecodeLimits::default()
        };
        let path = if self.project.is_dir() {
            self.project.join("project.json")
        } else {
            self.project
        };
        let raw = IrArgs::read_bounded(&path, &limits)?;
        let runtime = RuntimeProjectDocument::from_slice(
            &raw,
            &RuntimeProjectLimits {
                max_input_bytes: self.max_input_bytes,
                max_output_bytes: self.max_input_bytes,
                max_compositions: self.scene_limits.max_compositions,
                max_project_layers: self.scene_limits.max_project_layers,
            },
        )?
        .encode()?;
        let bytes = IrArgs::read_bounded(&self.request, &limits)?;
        let request: Request = serde_json::from_slice(&bytes)?;
        let scene = SceneProject::compile_document(
            &runtime,
            &self.scene_limits,
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        let preparation = scene.project_resource_requests(
            &request.frame,
            &request.context,
            &self.surface_limits,
        )?;
        let report = Report {
            schema_version: 1,
            kind: "native-project-resource-requests",
            project_sha256: format!("{:x}", Sha256::digest(&raw)),
            runtime_project_sha256: format!("{:x}", Sha256::digest(&runtime)),
            request_sha256: format!("{:x}", Sha256::digest(&bytes)),
            preparation_sha256: format!("{:x}", Sha256::digest(serde_json::to_vec(&preparation)?)),
            preparation,
        };
        let output = serde_json::to_vec(&report)?;
        if output.len() > self.max_input_bytes {
            return Err("resource request output exceeds byte budget".into());
        }
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&output)?;
        stdout.write_all(b"\n")?;
        Ok(ExitCode::SUCCESS)
    }
}

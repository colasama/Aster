use crate::ir::IrArgs;
use aster_eval::{
    EvaluationLimits, ExpressionLimits, RetainedRasterContext, RetainedRasterRequest, SceneLimits,
    SceneProject, TextExposureRequest, TextLayouts,
};
use aster_project::{RuntimeProjectDocument, RuntimeProjectLimits};
use aster_render_ir::DecodeLimits;
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf, process::ExitCode};

#[derive(Debug, Args)]
pub(crate) struct PrepareRastersArgs {
    #[arg(long)]
    project: PathBuf,
    /// Font-provider layout and native frame address; contains no supplied scene or effect plans.
    #[arg(long)]
    request: PathBuf,
    #[arg(long, default_value_t = 67_108_864)]
    max_input_bytes: usize,
    #[command(flatten)]
    scene_limits: SceneLimits,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    composition_id: String,
    time: f64,
    locale: String,
    layouts: TextLayouts,
    context: RetainedRasterContext,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    schema_version: u32,
    kind: &'static str,
    project_sha256: String,
    runtime_project_sha256: String,
    request_sha256: String,
    requests: Vec<RetainedRasterRequest>,
}

impl PrepareRastersArgs {
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
        let runtime =
            RuntimeProjectDocument::from_slice(&raw, &RuntimeProjectLimits::default())?.encode()?;
        let bytes = IrArgs::read_bounded(&self.request, &limits)?;
        let request: Request = serde_json::from_slice(&bytes)?;
        let scene = SceneProject::compile_document(
            &runtime,
            &self.scene_limits,
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        let exposure = scene.text_exposure_frame(
            &TextExposureRequest {
                composition_id: request.composition_id.clone(),
                time: request.time,
                resolution_scale: request.context.resolution_scale,
                locale: request.locale,
            },
            &request.layouts,
        )?;
        let report = Report {
            schema_version: 1,
            kind: "native-retained-raster-requests",
            project_sha256: format!("{:x}", Sha256::digest(&raw)),
            runtime_project_sha256: format!("{:x}", Sha256::digest(&runtime)),
            request_sha256: format!("{:x}", Sha256::digest(&bytes)),
            requests: scene.retained_raster_requests(
                &request.composition_id,
                &exposure.render_scene_layers,
                &request.context,
                &exposure.plans,
            )?,
        };
        let output = serde_json::to_vec(&report)?;
        if output.len() > self.max_input_bytes {
            return Err("raster request output exceeds byte budget".into());
        }
        let mut stdout = std::io::stdout().lock();
        stdout.write_all(&output)?;
        stdout.write_all(b"\n")?;
        Ok(ExitCode::SUCCESS)
    }
}

use crate::{ir::IrArgs, plan_input::PlanRequest};
use aster_eval::{
    BundleLimits, EvaluationError, EvaluationLimits, ExpressionLimits, GeneratorCatalog,
    NativeBundle, SceneLimits, SceneProject, SurfaceLimits,
};
use aster_render_ir::{DecodeLimits, ResourceHash, ResourceMessage};
use clap::Args;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::ExitCode,
};
use uuid::Uuid;

#[derive(Debug, Args)]
pub(crate) struct PlanProjectArgs {
    /// An admitted editor JSON document, or a bundle directory containing project.json.
    #[arg(long)]
    project: PathBuf,
    /// Frame address, admitted resources and observed allocation state as typed JSON.
    #[arg(long)]
    request: PathBuf,
    #[arg(long)]
    resource_manifest: Option<PathBuf>,
    #[arg(long)]
    resources: Option<PathBuf>,
    /// New output directory. Existing outputs are never replaced.
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value_t = 67_108_864)]
    max_input_bytes: usize,
    #[command(flatten)]
    bundle_limits: BundleLimits,
    #[command(flatten)]
    scene_limits: SceneLimits,
    #[command(flatten)]
    surface_limits: SurfaceLimits,
}

#[derive(Serialize)]
struct PlanReport {
    schema_version: u32,
    kind: &'static str,
    status: &'static str,
    project_sha256: String,
    runtime_project_sha256: String,
    source_schema_version: u64,
    request_sha256: String,
    plan_sha256: String,
    plan_bytes: usize,
    resource_count: usize,
    resource_bytes: usize,
    generator_observations: usize,
}

impl PlanProjectArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        if self.out.try_exists()? {
            return Err("output directory already exists".into());
        }
        if !(32..=67_108_864).contains(&self.max_input_bytes) {
            return Err("input byte limit must be between 32 and 67108864".into());
        }
        let limits = DecodeLimits {
            max_container_bytes: self.max_input_bytes,
            max_metadata_bytes: DecodeLimits::default()
                .max_metadata_bytes
                .min(self.max_input_bytes),
            ..DecodeLimits::default()
        };
        let project_path = if self.project.is_dir() {
            self.project.join("project.json")
        } else {
            self.project.clone()
        };
        let project_bytes = IrArgs::read_bounded(&project_path, &limits)?;
        let runtime = aster_project::RuntimeProjectDocument::from_slice(
            &project_bytes,
            &aster_project::RuntimeProjectLimits {
                max_input_bytes: self.max_input_bytes,
                max_output_bytes: self.max_input_bytes,
                max_compositions: self.scene_limits.max_compositions,
                max_project_layers: self.scene_limits.max_project_layers,
            },
        )?;
        let runtime_bytes = runtime.encode()?;
        let scene = SceneProject::compile_document(
            &runtime_bytes,
            &self.scene_limits,
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        let request_bytes = IrArgs::read_bounded(&self.request, &limits)?;
        let mut request: PlanRequest = serde_json::from_slice(&request_bytes)?;
        let packets = PlanRequest::load_packets(
            self.resource_manifest.as_deref(),
            self.resources.as_deref(),
            &limits,
            self.bundle_limits.clone(),
        )?;
        let resources = request.resources(packets, self.surface_limits)?;
        let catalog = GeneratorCatalog::compile(
            std::mem::take(&mut request.generators)
                .into_iter()
                .map(|g| (g.definition, g.source))
                .collect(),
            aster_plugin::generator::GeneratorLimits::default(),
            self.bundle_limits.clone(),
        )?;
        let mut observations = BTreeMap::new();
        for observation in request.generator_observations {
            observation.plan_sha256.validate()?;
            if observations
                .insert(observation.plan_sha256, observation.execution)
                .is_some()
            {
                return Err("duplicate generator observation".into());
            }
        }
        let observation_count = observations.len();
        let mut observed = std::collections::BTreeSet::new();
        let bundle = scene.plan_project_frame(
            &request.frame,
            &request.scene,
            resources,
            &catalog,
            self.bundle_limits,
            |generator| {
                let bytes = generator.plan.encode(&limits)?;
                let hash = ResourceHash(format!("{:x}", Sha256::digest(bytes)));
                let execution = observations.get(&hash).cloned().ok_or_else(|| {
                    EvaluationError::InvalidScene(
                        "exact generator invocation observation is absent".into(),
                    )
                })?;
                observed.insert(hash);
                Ok(execution)
            },
        )?;
        if observed.len() != observation_count {
            return Err("unused or stale generator observation".into());
        }
        let bytes = bundle.plan.encode(&limits)?;
        let report = PlanReport {
            schema_version: 1,
            kind: "native_project_plan",
            status: "passed",
            project_sha256: format!("{:x}", Sha256::digest(&project_bytes)),
            runtime_project_sha256: format!("{:x}", Sha256::digest(&runtime_bytes)),
            source_schema_version: runtime.source_version(),
            request_sha256: format!("{:x}", Sha256::digest(&request_bytes)),
            plan_sha256: format!("{:x}", Sha256::digest(&bytes)),
            plan_bytes: bytes.len(),
            resource_count: bundle.resources.len(),
            resource_bytes: bundle.resources.iter().map(|r| r.bytes().len()).sum(),
            generator_observations: observation_count,
        };
        Self::publish(&self.out, &bundle, &bytes, &report)?;
        println!("{}", serde_json::to_string(&report)?);
        Ok(ExitCode::SUCCESS)
    }

    fn publish(
        out: &Path,
        bundle: &NativeBundle,
        plan: &[u8],
        report: &PlanReport,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let parent = out
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".aster-project-plan-{}.tmp", Uuid::new_v4()));
        fs::create_dir(&temporary)?;
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            fs::create_dir(temporary.join("resources"))?;
            Self::write_file(&temporary.join("plan.fpln"), plan)?;
            let mut messages = Vec::new();
            for resource in &bundle.resources {
                messages.push(ResourceMessage::PutResource(resource.request().clone()));
                Self::write_file(
                    &temporary
                        .join("resources")
                        .join(format!("{}.bin", resource.request().hash.0)),
                    resource.bytes(),
                )?;
            }
            Self::write_file(
                &temporary.join("resources.json"),
                &serde_json::to_vec(&messages)?,
            )?;
            Self::write_file(
                &temporary.join("report.json"),
                &serde_json::to_vec_pretty(report)?,
            )?;
            if out.try_exists()? {
                return Err("output directory appeared during generation".into());
            }
            fs::rename(&temporary, out)?;
            Ok(())
        })();
        if temporary.try_exists()? {
            fs::remove_dir_all(&temporary)?;
        }
        result
    }

    fn write_file(path: &Path, bytes: &[u8]) -> Result<(), std::io::Error> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }
}

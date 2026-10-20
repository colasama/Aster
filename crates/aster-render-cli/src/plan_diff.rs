use crate::{ir::IrArgs, plan_input::PlanRequest};
use aster_eval::BundleLimits;
use aster_render_ir::{
    DecodeLimits, FplnCodec, OwnedFpln, PlanComparison, PlanComparisonReport, ResourceKind,
    ResourceLimits, ResourceRegistry,
};
use clap::Args;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

#[derive(Debug, Args)]
pub(crate) struct PlanDiffArgs {
    #[arg(long)]
    a: PathBuf,
    #[arg(long)]
    b: PathBuf,
    #[arg(long)]
    a_resources: Option<PathBuf>,
    #[arg(long)]
    b_resources: Option<PathBuf>,
    #[arg(long)]
    a_resource_manifest: Option<PathBuf>,
    #[arg(long)]
    b_resource_manifest: Option<PathBuf>,
    #[arg(long)]
    out: Option<PathBuf>,
    #[arg(long, default_value_t = 1e-5)]
    relative: f64,
    #[arg(long, default_value_t = 1e-6)]
    absolute: f64,
    #[arg(long, default_value_t = 65536)]
    max_plans: usize,
    #[command(flatten)]
    bundle_limits: BundleLimits,
}
struct DiffInput {
    plan: OwnedFpln,
    registry: ResourceRegistry,
    sha256: String,
}
#[derive(Serialize)]
struct DiffReport {
    schema_version: u32,
    kind: &'static str,
    status: &'static str,
    a_sha256: String,
    b_sha256: String,
    relative: f64,
    absolute: f64,
    #[serde(flatten)]
    comparison: PlanComparisonReport,
}
impl PlanDiffArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        let limits = DecodeLimits::default();
        let a = DiffInput::load(
            &self.a,
            self.a_resource_manifest,
            self.a_resources,
            &limits,
            &self.bundle_limits,
        )?;
        let b = DiffInput::load(
            &self.b,
            self.b_resource_manifest,
            self.b_resources,
            &limits,
            &self.bundle_limits,
        )?;
        let comparison = PlanComparison {
            relative: self.relative,
            absolute: self.absolute,
            max_plans: self.max_plans,
            ..Default::default()
        }
        .compare(&a.plan, &a.registry, &b.plan, &b.registry, &limits)?;
        let equal = comparison.equal;
        let report = DiffReport {
            schema_version: 1,
            kind: "plan_diff",
            status: if equal { "passed" } else { "different" },
            a_sha256: a.sha256,
            b_sha256: b.sha256,
            relative: self.relative,
            absolute: self.absolute,
            comparison,
        };
        let json = serde_json::to_vec(&report)?;
        if let Some(path) = self.out {
            IrArgs::publish(&path, &json)?;
        }
        println!("{}", String::from_utf8(json)?);
        Ok(if equal {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(1)
        })
    }
}
impl DiffInput {
    fn load(
        path: &Path,
        manifest: Option<PathBuf>,
        directory: Option<PathBuf>,
        limits: &DecodeLimits,
        budget: &BundleLimits,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let bytes = IrArgs::read_bounded(path, limits)?;
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let plan = FplnCodec::decode(bytes, limits)?;
        let needs_resources =
            !plan.metadata.resources.is_empty() || manifest.is_some() || directory.is_some();
        let manifest =
            manifest.or_else(|| needs_resources.then(|| path.with_file_name("resources.json")));
        let directory =
            directory.or_else(|| needs_resources.then(|| path.with_file_name("resources")));
        let mut packets = PlanRequest::load_packets(
            manifest.as_deref(),
            directory.as_deref(),
            limits,
            budget.clone(),
        )?;
        if !plan
            .metadata
            .resources
            .iter()
            .eq(packets.iter().map(|p| &p.request().hash))
        {
            return Err("plan comparison requires the exact declared resource closure".into());
        }
        packets.sort_by_key(|p| match p.request().kind {
            ResourceKind::MediaSource => 0,
            ResourceKind::MediaFrame => 1,
            ResourceKind::RasterPixels => 2,
            _ => 3,
        });
        let mut registry = ResourceRegistry::new(ResourceLimits {
            budget_bytes: budget.max_bundle_bytes as u64,
            ..Default::default()
        })?;
        for packet in packets {
            registry.put_verified(packet)?;
        }
        Ok(Self {
            plan,
            registry,
            sha256,
        })
    }
}

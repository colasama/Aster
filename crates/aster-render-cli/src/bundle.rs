use std::{collections::BTreeMap, path::PathBuf};

use aster_render_ir::{
    ContractLevel, DecodeLimits, FplnCodec, IrError, PlanSlice, ResourceKind, ResourceLimits,
    ResourceMessage, ResourceRegistry,
};
use clap::Args;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ir::{IrArgs, IrLimits};

#[derive(Debug, Args)]
pub struct BundleArgs {
    #[arg(long)]
    input: PathBuf,
    #[arg(long)]
    submitted: PathBuf,
    #[arg(long)]
    resources: PathBuf,
    #[arg(long)]
    payloads: PathBuf,
    #[arg(long)]
    output: PathBuf,
    #[arg(long, default_value_t = 67_108_864)]
    resource_byte_budget: usize,
    #[command(flatten)]
    limits: IrLimits,
}

#[derive(Serialize)]
struct BundleReport {
    schema_version: u32,
    kind: &'static str,
    status: &'static str,
    submitted_sha256: String,
    replay_sha256: String,
    roundtrip_sha256: String,
    resources: usize,
    resource_bytes: usize,
    nested_plans: usize,
}

impl BundleArgs {
    pub fn run(self) -> Result<(), IrError> {
        let limits = DecodeLimits::from(self.limits);
        let input = IrArgs::read_bounded(&self.input, &limits)?;
        let submitted = IrArgs::read_bounded(&self.submitted, &limits)?;
        let plan = FplnCodec::decode(input.clone(), &limits)?;
        let live = FplnCodec::decode(submitted.clone(), &limits)?;
        if plan.metadata.contract_level != ContractLevel::FrameBundleSliceV1
            || live.metadata.contract_level != ContractLevel::FrameBundleSliceV1
            || plan.metadata.header != live.metadata.header
        {
            return Err(IrError::InvalidHeader(
                "expected matching frame bundles".to_owned(),
            ));
        }
        let mut executable = plan.metadata.clone();
        let Some(PlanSlice::FrameBundle(bundle)) = executable.slices.first_mut() else {
            return Err(IrError::InvalidHeader("missing frame envelope".to_owned()));
        };
        let mut expected_resources = live.metadata.resources.clone();
        expected_resources.extend(bundle.media_pixels.iter().map(|pixel| pixel.pixels.clone()));
        expected_resources.sort();
        expected_resources.dedup();
        if expected_resources != plan.metadata.resources {
            return Err(IrError::InvalidResource(
                "capture added non-pixel dependencies".to_owned(),
            ));
        }
        bundle.media_pixels.clear();
        executable.resources = live.metadata.resources.clone();
        let mut counts = plan.blob(0)?.to_vec();
        counts[16..20].copy_from_slice(&0_u32.to_le_bytes());
        if FplnCodec::encode(executable, &[&counts], &limits)? != submitted {
            return Err(IrError::InvalidHeader(
                "capture changed submitted execution".to_owned(),
            ));
        }
        let messages: Vec<ResourceMessage> =
            serde_json::from_slice(&IrArgs::read_bounded(&self.resources, &limits)?)
                .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        let mut entries = BTreeMap::new();
        for message in messages {
            let ResourceMessage::PutResource(request) = message else {
                return Err(IrError::InvalidResource(
                    "bundle contains eviction".to_owned(),
                ));
            };
            request.hash.validate()?;
            if entries.insert(request.hash.clone(), request).is_some() {
                return Err(IrError::ResourceConflict);
            }
        }
        if entries.len() != plan.metadata.resources.len()
            || !plan.metadata.resources.iter().eq(entries.keys())
            || live
                .metadata
                .resources
                .iter()
                .any(|hash| !entries.contains_key(hash))
        {
            return Err(IrError::MissingResource(
                "bundle dependency closure".to_owned(),
            ));
        }
        let resource_count = entries.len();
        let mut ordered = entries.into_values().collect::<Vec<_>>();
        ordered.sort_by_key(|request| match request.kind {
            ResourceKind::MediaSource => 0,
            ResourceKind::MediaFrame => 1,
            ResourceKind::RasterPixels => 2,
            _ => 3,
        });
        let mut registry = ResourceRegistry::new(ResourceLimits {
            budget_bytes: self.resource_byte_budget as u64,
            ..ResourceLimits::default()
        })?;
        let mut resource_bytes = 0_usize;
        for request in ordered {
            let bytes = IrArgs::read_bounded(
                &self.payloads.join(format!("{}.bin", request.hash.0)),
                &limits,
            )?;
            resource_bytes = resource_bytes
                .checked_add(bytes.len())
                .ok_or(IrError::ArithmeticOverflow)?;
            if resource_bytes > self.resource_byte_budget {
                return Err(IrError::LimitExceeded("bundle resource bytes".to_owned()));
            }
            registry.put(request, bytes)?;
        }
        let nested_plans = aster_render_ir::BundleDependencies::default()
            .with_roundtrip()
            .validate(&plan.metadata, &registry, &limits)?;
        let output = plan.reencode(&limits)?;
        if output != input || live.reencode(&limits)? != submitted {
            return Err(IrError::InvalidHeader("noncanonical frame plan".to_owned()));
        }
        IrArgs::publish(&self.output, &output)?;
        let report = BundleReport {
            schema_version: 1,
            kind: "ir_bundle",
            status: "passed",
            submitted_sha256: format!("{:x}", Sha256::digest(submitted)),
            replay_sha256: format!("{:x}", Sha256::digest(input)),
            roundtrip_sha256: format!("{:x}", Sha256::digest(output)),
            resources: resource_count,
            resource_bytes,
            nested_plans,
        };
        println!(
            "{}",
            serde_json::to_string(&report)
                .map_err(|error| IrError::InvalidJson(error.to_string()))?
        );
        Ok(())
    }
}

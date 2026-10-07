use crate::{ir::IrArgs, native_stills::NativeStillResources};
use aster_render_ir::{
    DecodeLimits, FplnCodec, IrError, ResourceKind, ResourceLimits, ResourceMessage,
    ResourceRegistry,
};
use aster_renderer::SuppliedFrame;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RenderJob {
    pub plan: PathBuf,
    pub resources: PathBuf,
    pub resource_manifest: Option<PathBuf>,
    pub out: PathBuf,
}

pub(crate) struct RenderInput {
    pub frame: SuppliedFrame,
    pub registry: ResourceRegistry,
    pub native: NativeStillResources,
    pub plan_sha256: String,
    pub output: PathBuf,
}

impl RenderInput {
    pub fn load(
        job: RenderJob,
        limits: &DecodeLimits,
        resource_byte_budget: u64,
        native_media: Option<&mut aster_media_native::NativeMediaSession>,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        if job.out.exists() {
            return Err("output already exists".into());
        }
        let bytes = IrArgs::read_bounded(&job.plan, limits)?;
        let plan_sha256 = format!("{:x}", Sha256::digest(&bytes));
        let plan = FplnCodec::decode(bytes, limits)?;
        let resources = job.resources;
        let manifest = job
            .resource_manifest
            .unwrap_or_else(|| job.plan.with_file_name("resources.json"));
        let messages: Vec<ResourceMessage> =
            serde_json::from_slice(&IrArgs::read_bounded(&manifest, limits)?)?;
        let mut requests = BTreeMap::new();
        for message in messages {
            let ResourceMessage::PutResource(request) = message else {
                return Err(
                    IrError::InvalidResource("frame manifest contains eviction".into()).into(),
                );
            };
            request.hash.validate()?;
            if requests.insert(request.hash.clone(), request).is_some() {
                return Err(IrError::ResourceConflict.into());
            }
        }
        if !plan.metadata.resources.iter().eq(requests.keys()) {
            return Err(IrError::MissingResource("exact frame closure required".into()).into());
        }
        let mut ordered = requests.into_values().collect::<Vec<_>>();
        ordered.sort_by_key(|request| match request.kind {
            ResourceKind::MediaSource => 0,
            ResourceKind::MediaFrame => 1,
            ResourceKind::RasterPixels => 2,
            _ => 3,
        });
        let mut registry = ResourceRegistry::new(ResourceLimits {
            budget_bytes: resource_byte_budget,
            ..Default::default()
        })?;
        let mut total = 0_u64;
        for request in ordered {
            let payload =
                IrArgs::read_bounded(&resources.join(format!("{}.bin", request.hash.0)), limits)?;
            total = total
                .checked_add(payload.len() as u64)
                .ok_or(IrError::ArithmeticOverflow)?;
            if total > resource_byte_budget {
                return Err(IrError::LimitExceeded("frame resource budget".into()).into());
            }
            registry.put(request, payload)?;
        }
        let native = NativeStillResources::install(native_media, &plan, &mut registry, limits)?;
        let frame = SuppliedFrame::new(plan, &registry, limits, &native.pixels)?;
        Ok(Self {
            frame,
            registry,
            native,
            plan_sha256,
            output: job.out,
        })
    }
}

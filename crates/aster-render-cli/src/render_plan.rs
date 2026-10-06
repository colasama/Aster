use std::{
    collections::BTreeMap,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use aster_render::{AdapterDiagnostics, NativeBackend};
use aster_render_compare::{image::RgbaImage, png::PngCodec};
use aster_render_ir::{
    DecodeLimits, FplnCodec, IrError, ResourceKind, ResourceLimits, ResourceMessage,
    ResourceRegistry,
};
use aster_renderer::{NativeOptions, NativeRenderer, SuppliedFrame};
use clap::Args;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::ir::{IrArgs, IrLimits};

#[derive(Debug, Args)]
pub struct RenderPlanArgs {
    #[arg(long)]
    plan: PathBuf,
    /// Content-addressed .bin payload directory. No media source path is opened.
    #[arg(long)]
    resources: Option<PathBuf>,
    /// Defaults to resources.json beside the plan.
    #[arg(long)]
    resource_manifest: Option<PathBuf>,
    #[arg(long)]
    out: Option<PathBuf>,
    /// Validate and print metadata without creating a GPU device.
    #[arg(long)]
    dump: bool,
    #[arg(long, default_value="auto", value_parser=["auto", "dx12", "vulkan", "metal"])]
    backend: String,
    /// Exact adapter name; omission selects a hardware high-performance adapter.
    #[arg(long)]
    adapter: Option<String>,
    /// Explicit existing DXC library for native DX12 effect programs.
    #[arg(long)]
    dxcompiler: Option<PathBuf>,
    #[arg(long, default_value_t = 536_870_912)]
    gpu_budget_bytes: u64,
    #[arg(long, default_value_t = 67_108_864)]
    resource_byte_budget: u64,
    #[arg(long, default_value_t = 30_000)]
    timeout_ms: u64,
    #[command(flatten)]
    limits: IrLimits,
    #[command(flatten)]
    native_stills: crate::native_stills::NativeStillArgs,
}

#[derive(Serialize)]
struct RenderReport {
    schema_version: u32,
    status: &'static str,
    native_gpu_execution: bool,
    diagnostic_readback: bool,
    native_image_decode: bool,
    native_images: Vec<aster_media_native::NativeImageReceipt>,
    image_cache: aster_renderer::ImageCacheStatistics,
    adapter: AdapterDiagnostics,
    plan_sha256: String,
    rgba_sha256: String,
    width: u32,
    height: u32,
    output: PathBuf,
    duration_ms: u128,
}

impl RenderPlanArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        let started = Instant::now();
        let limits = DecodeLimits::from(self.limits);
        let bytes = IrArgs::read_bounded(&self.plan, &limits)?;
        let plan_sha256 = format!("{:x}", Sha256::digest(&bytes));
        let plan = FplnCodec::decode(bytes, &limits)?;
        if self.dump {
            println!("{}", String::from_utf8(plan.metadata_json(&limits)?)?);
            return Ok(ExitCode::SUCCESS);
        }
        let output = self.out.ok_or("--out is required unless --dump is used")?;
        if output.exists() {
            return Err("output already exists".into());
        }
        let resources = self
            .resources
            .ok_or("--resources is required unless --dump is used")?;
        let manifest = self
            .resource_manifest
            .unwrap_or_else(|| self.plan.with_file_name("resources.json"));
        let messages: Vec<ResourceMessage> =
            serde_json::from_slice(&IrArgs::read_bounded(&manifest, &limits)?)?;
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
            budget_bytes: self.resource_byte_budget,
            ..Default::default()
        })?;
        let mut total = 0_u64;
        for request in ordered {
            let payload =
                IrArgs::read_bounded(&resources.join(format!("{}.bin", request.hash.0)), &limits)?;
            total = total
                .checked_add(payload.len() as u64)
                .ok_or(IrError::ArithmeticOverflow)?;
            if total > self.resource_byte_budget {
                return Err(IrError::LimitExceeded("frame resource budget".into()).into());
            }
            registry.put(request, payload)?;
        }
        let native = self.native_stills.install(&plan, &mut registry, &limits)?;
        let frame = SuppliedFrame::new(plan, &registry, &limits, &native.pixels)?;
        let backend = match self.backend.as_str() {
            "dx12" => NativeBackend::Dx12,
            "metal" => NativeBackend::Metal,
            "vulkan" => NativeBackend::Vulkan,
            _ if cfg!(target_os = "windows") => NativeBackend::Dx12,
            _ if cfg!(target_os = "macos") => NativeBackend::Metal,
            _ => NativeBackend::Vulkan,
        };
        let mut renderer = NativeRenderer::new(NativeOptions {
            backend,
            adapter_name: self.adapter,
            dxcompiler: self.dxcompiler,
            gpu_budget_bytes: self.gpu_budget_bytes,
            timeout: Duration::from_millis(self.timeout_ms),
        })?;
        let rendered = renderer.render(&frame, &registry)?;
        let pixels = renderer.read_rgba(&rendered)?;
        let rgba_sha256 = format!("{:x}", Sha256::digest(&pixels));
        let image = RgbaImage::new(rendered.size.width, rendered.size.height, pixels)?;
        IrArgs::publish(&output, &PngCodec::encode(&image)?)?;
        println!(
            "{}",
            serde_json::to_string(&RenderReport {
                schema_version: 1,
                status: "passed",
                native_gpu_execution: true,
                diagnostic_readback: true,
                native_image_decode: !native.receipts.is_empty(),
                native_images: native.receipts,
                image_cache: rendered.image_cache,
                adapter: renderer.diagnostics,
                plan_sha256,
                rgba_sha256,
                width: image.width,
                height: image.height,
                output,
                duration_ms: started.elapsed().as_millis(),
            })?
        );
        Ok(ExitCode::SUCCESS)
    }
}

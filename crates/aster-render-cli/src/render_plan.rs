use std::{
    collections::BTreeSet,
    path::PathBuf,
    process::ExitCode,
    time::{Duration, Instant},
};

use aster_render::{AdapterDiagnostics, NativeBackend};
use aster_render_compare::{image::RgbaImage, png::PngCodec};
use aster_render_ir::{DecodeLimits, FplnCodec};
use aster_renderer::{NativeOptions, NativeRenderer};
use clap::Args;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    ir::{IrArgs, IrLimits},
    render_input::{RenderInput, RenderJob},
};

#[derive(Debug, Args)]
pub struct RenderPlanArgs {
    #[arg(long, required_unless_present = "batch", conflicts_with = "batch")]
    plan: Option<PathBuf>,
    /// Bounded JSON list of supplied frame jobs, executed on one retained native device.
    #[arg(long, conflicts_with_all = ["plan", "dump", "out", "resources", "resource_manifest"])]
    batch: Option<PathBuf>,
    #[arg(long, default_value_t = 4096)]
    max_batch_frames: usize,
    /// Content-addressed .bin payload directory; native file access requires separate grants.
    #[arg(long)]
    resources: Option<PathBuf>,
    /// Defaults to resources.json beside the plan.
    #[arg(long)]
    resource_manifest: Option<PathBuf>,
    #[arg(long)]
    out: Option<PathBuf>,
    /// Save diagnostic BT.709 limited NV12 from the same GPU frame before encoding.
    #[arg(long, conflicts_with_all = ["batch", "dump"])]
    nv12_out: Option<PathBuf>,
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
    /// Optional isolated layer result cache; zero provides the uncached diagnostic path.
    #[arg(long, default_value_t = 67_108_864)]
    layer_cache_bytes: u64,
    #[arg(long, default_value_t = 16)]
    effect_pipeline_entries: usize,
    /// Read GPU stage timestamps for diagnostics; changes synchronization and is not a benchmark.
    #[arg(long)]
    gpu_timestamps: bool,
    /// Disable bounded effect scissors for native parity diagnostics.
    #[arg(long)]
    full_effect_regions: bool,
    #[arg(long, default_value_t = 67_108_864)]
    resource_byte_budget: u64,
    #[arg(long, default_value_t = 30_000)]
    timeout_ms: u64,
    #[command(flatten)]
    limits: IrLimits,
    #[command(flatten)]
    native_stills: crate::native_stills::NativeStillArgs,
    #[command(flatten)]
    native_textures: crate::native_textures::NativeTextureArgs,
}

#[derive(Serialize)]
struct RenderReport {
    schema_version: u32,
    status: &'static str,
    native_gpu_execution: bool,
    diagnostic_readback: bool,
    native_image_decode: bool,
    native_images: Vec<aster_media_native::NativeImageReceipt>,
    native_videos: Vec<aster_media_native::NativeVideoReceipt>,
    native_textures: Vec<aster_media_native::NativeTextureReceipt>,
    texture_decode_cache: aster_media_native::MediaCacheStatistics,
    media_decode_cache: aster_media_native::MediaCacheStatistics,
    video_source_cache: aster_media_native::VideoSourceCacheStatistics,
    video_decode_window: aster_media_native::VideoWindowStatistics,
    image_cache: aster_renderer::ImageCacheStatistics,
    lut_cache: aster_renderer::LutCacheStatistics,
    surface_cache: aster_renderer::SurfaceCacheStatistics,
    layer_cache: aster_renderer::LayerCacheStatistics,
    effect_regions: aster_renderer::EffectRegionStatistics,
    temporal_cache: aster_renderer::TemporalCacheStatistics,
    motion_reconstruction: aster_renderer::MotionStatistics,
    depth_effects: aster_renderer::DepthStatistics,
    #[serde(skip_serializing_if = "Option::is_none")]
    gpu_timings: Option<aster_renderer::GpuTimings>,
    adapter: AdapterDiagnostics,
    plan_sha256: String,
    rgba_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    nv12: Option<Nv12Report>,
    width: u32,
    height: u32,
    output: PathBuf,
    duration_ms: u128,
    renderer_reused: bool,
    frame_index: usize,
}

#[derive(Serialize)]
struct Nv12Report {
    path: PathBuf,
    sha256: String,
    bytes: usize,
    format: &'static str,
}

impl RenderPlanArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        let limits = DecodeLimits::from(self.limits);
        if let Some(path) = &self.nv12_out
            && (path.exists() || self.out.as_ref() == Some(path))
        {
            return Err("NV12 diagnostic output must be new and distinct from PNG output".into());
        }
        if self.dump {
            let path = self.plan.as_ref().ok_or("--plan is required for --dump")?;
            let plan = FplnCodec::decode(IrArgs::read_bounded(path, &limits)?, &limits)?;
            println!("{}", String::from_utf8(plan.metadata_json(&limits)?)?);
            return Ok(ExitCode::SUCCESS);
        }
        let jobs = if let Some(path) = &self.batch {
            let jobs: Vec<RenderJob> =
                serde_json::from_slice(&IrArgs::read_bounded(path, &limits)?)?;
            if jobs.is_empty() || jobs.len() > self.max_batch_frames {
                return Err("batch frame count is empty or exceeds limit".into());
            }
            let mut destinations = BTreeSet::new();
            let capture_nv12 = jobs[0].nv12_out.is_some();
            let mut nv12_size = None;
            for job in &jobs {
                if job.nv12_out.is_some() != capture_nv12 {
                    return Err("batch NV12 capture must be enabled for every frame".into());
                }
                for output in std::iter::once(&job.out).chain(job.nv12_out.iter()) {
                    if !output.is_absolute()
                        || output
                            .components()
                            .any(|part| matches!(part, std::path::Component::ParentDir))
                    {
                        return Err(
                            "batch output paths must be absolute without parent traversal".into(),
                        );
                    }
                    let name = output.to_string_lossy().to_string();
                    let key = if cfg!(windows) {
                        name.to_lowercase()
                    } else {
                        name
                    };
                    if !destinations.insert(key) || output.exists() {
                        return Err("duplicate batch destination or output already exists".into());
                    }
                }
            }
            // Reject incompatible conversion sessions before any frame can publish an artifact.
            if capture_nv12 {
                for job in &jobs {
                    let plan =
                        FplnCodec::decode(IrArgs::read_bounded(&job.plan, &limits)?, &limits)?;
                    let size = plan.metadata.header.target;
                    if !size.width.is_multiple_of(2)
                        || !size.height.is_multiple_of(2)
                        || nv12_size.is_some_and(|expected| expected != size)
                    {
                        return Err("batch NV12 capture requires fixed even dimensions".into());
                    }
                    nv12_size = Some(size);
                }
            }
            jobs
        } else {
            vec![RenderJob {
                plan: self.plan.ok_or("--plan is required")?,
                resources: self
                    .resources
                    .ok_or("--resources is required unless --dump is used")?,
                resource_manifest: self.resource_manifest,
                out: self.out.ok_or("--out is required unless --dump is used")?,
                nv12_out: self.nv12_out,
            }]
        };
        let backend = match self.backend.as_str() {
            "dx12" => NativeBackend::Dx12,
            "metal" => NativeBackend::Metal,
            "vulkan" => NativeBackend::Vulkan,
            _ if cfg!(target_os = "windows") => NativeBackend::Dx12,
            _ if cfg!(target_os = "macos") => NativeBackend::Metal,
            _ => NativeBackend::Vulkan,
        };
        let mut renderer = None;
        let mut native_media = self.native_stills.session(&limits)?;
        let mut native_textures = self.native_textures.session()?;
        for (frame_index, job) in jobs.into_iter().enumerate() {
            let started = Instant::now();
            let input = RenderInput::load(
                job,
                &limits,
                self.resource_byte_budget,
                native_media.as_mut(),
                native_textures.as_mut(),
            )?;
            let reused = renderer.is_some();
            if renderer.is_none() {
                renderer = Some(NativeRenderer::new(NativeOptions {
                    backend,
                    adapter_name: self.adapter.clone(),
                    dxcompiler: self.dxcompiler.clone(),
                    gpu_budget_bytes: self.gpu_budget_bytes,
                    layer_cache_bytes: self.layer_cache_bytes,
                    effect_pipeline_entries: self.effect_pipeline_entries,
                    gpu_timestamps: self.gpu_timestamps,
                    effect_regions: !self.full_effect_regions,
                    timeout: Duration::from_millis(self.timeout_ms),
                })?);
            }
            let renderer = renderer.as_mut().ok_or("native device missing")?;
            if input.nv12_output.is_some() {
                renderer.prepare_nv12(input.output_size)?;
            }
            let rendered = renderer.render(&input.frame, &input.registry)?;
            let nv12 = if let Some(path) = &input.nv12_output {
                let bytes = renderer.read_nv12(&rendered)?;
                let report = Nv12Report {
                    path: path.clone(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                    bytes: bytes.len(),
                    format: "nv12-bt709-limited",
                };
                Some((report, bytes))
            } else {
                None
            };
            let pixels = renderer.read_rgba(&rendered)?;
            let rgba_sha256 = format!("{:x}", Sha256::digest(&pixels));
            let image = RgbaImage::new(rendered.size.width, rendered.size.height, pixels)?;
            IrArgs::publish(&input.output, &PngCodec::encode(&image)?)?;
            let nv12 = match nv12 {
                Some((report, bytes)) => {
                    IrArgs::publish(&report.path, &bytes)?;
                    Some(report)
                }
                None => None,
            };
            println!(
                "{}",
                serde_json::to_string(&RenderReport {
                    schema_version: 1,
                    status: "passed",
                    native_gpu_execution: true,
                    diagnostic_readback: true,
                    native_image_decode: !input.native.receipts.is_empty(),
                    native_images: input.native.receipts,
                    native_videos: input.native.video_receipts,
                    native_textures: input.textures.receipts,
                    texture_decode_cache: input.textures.cache,
                    media_decode_cache: input.native.decode_cache,
                    video_source_cache: input.native.video_source_cache,
                    video_decode_window: input.native.video_decode_window,
                    image_cache: rendered.image_cache,
                    lut_cache: rendered.lut_cache,
                    surface_cache: rendered.surface_cache,
                    layer_cache: rendered.layer_cache,
                    effect_regions: rendered.effect_regions,
                    temporal_cache: rendered.temporal_cache,
                    motion_reconstruction: rendered.motion_reconstruction,
                    depth_effects: rendered.depth_effects,
                    gpu_timings: renderer.gpu_timings(),
                    adapter: renderer.diagnostics.clone(),
                    plan_sha256: input.plan_sha256,
                    rgba_sha256,
                    nv12,
                    width: image.width,
                    height: image.height,
                    output: input.output,
                    duration_ms: started.elapsed().as_millis(),
                    renderer_reused: reused,
                    frame_index,
                })?
            );
        }
        Ok(ExitCode::SUCCESS)
    }
}

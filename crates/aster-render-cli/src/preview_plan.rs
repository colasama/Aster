use crate::preview_transport::{
    PreviewDescription, PreviewProducedFrame, PreviewProducer, PreviewSource,
};
use aster_render::NativeBackend;
use aster_render_ir::DecodeLimits;
use aster_renderer::{NativeOptions, NativeRenderer};
use clap::Args;
use std::{path::PathBuf, process::ExitCode, time::Duration};

use crate::{
    ir::IrLimits,
    render_input::{RenderInput, RenderJob},
};

#[derive(Debug, Args)]
pub struct PreviewPlanArgs {
    #[arg(long)]
    plan: PathBuf,
    #[arg(long)]
    resources: PathBuf,
    #[arg(long)]
    resource_manifest: Option<PathBuf>,
    #[command(flatten)]
    transport: crate::preview_transport::PreviewTransportArgs,
    #[arg(long)]
    adapter: Option<String>,
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
    #[command(flatten)]
    native_textures: crate::native_textures::NativeTextureArgs,
}

impl PreviewPlanArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        if self.timeout_ms == 0 {
            return Err("invalid preview timeout or control limit".into());
        }
        let limits = DecodeLimits::from(self.limits);
        limits.validate()?;
        let mut media = self.native_stills.session(&limits)?;
        let mut textures = self.native_textures.session()?;
        let input = RenderInput::load(
            RenderJob {
                plan: self.plan,
                resources: self.resources,
                resource_manifest: self.resource_manifest,
                // RenderInput's diagnostic destination is never published by a preview session.
                out: std::env::temp_dir().join(format!("aster-preview-{}", uuid::Uuid::new_v4())),
                nv12_out: None,
            },
            &limits,
            self.resource_byte_budget,
            media.as_mut(),
            textures.as_mut(),
        )?;
        let mut renderer = NativeRenderer::new(NativeOptions {
            backend: NativeBackend::Dx12,
            adapter_name: self.adapter,
            dxcompiler: self.dxcompiler,
            gpu_budget_bytes: self.gpu_budget_bytes,
            layer_cache_bytes: 0,
            effect_pipeline_entries: 16,
            effect_regions: true,
            gpu_timestamps: false,
            timeout: Duration::from_millis(self.timeout_ms),
        })?;
        renderer.prepare_shared_preview(input.output_size, self.transport.slots)?;
        let mut producer = PreviewPlanSession { renderer, input };
        let result = self.transport.serve(&mut producer);
        producer.renderer.release_shared_preview()?;
        result
    }
}

struct PreviewPlanSession {
    renderer: NativeRenderer,
    input: RenderInput,
}
impl PreviewProducer for PreviewPlanSession {
    fn describe(&self) -> Result<PreviewDescription, Box<dyn std::error::Error>> {
        Ok(PreviewDescription {
            adapter: self.renderer.diagnostics.clone(),
            width: self.input.output_size.width,
            height: self.input.output_size.height,
            source: PreviewSource::Plan {
                sha256: self.input.plan_sha256.clone(),
            },
        })
    }
    fn render(
        &mut self,
        time: Option<f64>,
    ) -> Result<PreviewProducedFrame, Box<dyn std::error::Error>> {
        if time.is_some() {
            return Err("supplied preview plan has a fixed time".into());
        }
        let rendered = self
            .renderer
            .render(&self.input.frame, &self.input.registry)?;
        Ok(PreviewProducedFrame {
            surface: self.renderer.share_preview(&rendered)?,
            timings: None,
        })
    }
}

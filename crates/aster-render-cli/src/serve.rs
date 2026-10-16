mod export;
mod inputs;
mod response;

use std::{
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
    time::Duration,
};

use aster_encode::{EncoderOptions, HardwareEncoderProbe};
use aster_render::{AdapterDiagnostics, NativeBackend};
use aster_render_ir::{
    DecodeLimits, FplnCodec, PutOutcome, ResourceLimits, ResourceRegistry, SessionCommand,
    SessionReader, SessionSchema, SessionWireLimits,
};
use aster_renderer::{NativeOptions, NativeRenderer, SuppliedFrame};
use clap::Args;
use sha2::{Digest, Sha256};

use crate::{ir::IrLimits, native_stills::NativeStillArgs, native_textures::NativeTextureArgs};
use response::{Reply, ReplyBody};

#[derive(Debug, Args)]
pub struct ServeArgs {
    /// Print the deterministic control-request schema without opening a device or session.
    #[arg(long)]
    schema: bool,
    #[arg(long, default_value_t = 65_536)]
    max_control_bytes: usize,
    #[arg(long, default_value_t = 67_108_864)]
    max_payload_bytes: usize,
    #[arg(long, default_value_t = 536_870_912)]
    resource_byte_budget: u64,
    #[arg(long, default_value_t = 65_536)]
    max_session_resources: usize,
    #[arg(long, default_value_t = 536_870_912)]
    gpu_budget_bytes: u64,
    #[arg(long, default_value_t = 67_108_864)]
    layer_cache_bytes: u64,
    #[arg(long, default_value_t = 16)]
    effect_pipeline_entries: usize,
    /// Enable diagnostic GPU timestamps; never use for throughput acceptance.
    #[arg(long)]
    gpu_timestamps: bool,
    #[arg(long, default_value_t = 30_000)]
    timeout_ms: u64,
    #[arg(long)]
    dxcompiler: Option<PathBuf>,
    #[command(flatten)]
    limits: IrLimits,
    #[command(flatten)]
    encoder: EncoderOptions,
    /// Enable the experimental in-process NV12 readback export route.
    #[arg(long)]
    native_readback_export: bool,
    /// Enable experimental DX12/D3D11 shared NV12 hardware encoding.
    #[arg(long, conflicts_with = "native_readback_export")]
    native_shared_export: bool,
    /// Prefer shared GPU input and report a hardware-only NV12 readback fallback when unavailable.
    #[arg(long, conflicts_with_all = ["native_readback_export", "native_shared_export"])]
    native_export: bool,
    #[command(flatten)]
    textures: NativeTextureArgs,
    #[command(flatten)]
    media: NativeStillArgs,
}

struct Worker {
    export: Option<export::ExportSession>,
    registry: ResourceRegistry,
    limits: DecodeLimits,
    textures: Option<aster_media_native::NativeTextureSession>,
    media: Option<aster_media_native::NativeMediaSession>,
    renderer: Option<NativeRenderer>,
    dxcompiler: Option<PathBuf>,
    gpu_budget_bytes: u64,
    layer_cache_bytes: u64,
    effect_pipeline_entries: usize,
    gpu_timestamps: bool,
    timeout: Duration,
    encoder: EncoderOptions,
    native_readback_export: bool,
    native_shared_export: bool,
    native_export: bool,
}

impl ServeArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        let mut output = io::BufWriter::new(io::stdout().lock());
        if self.schema {
            output.write_all(&SessionSchema::emit()?)?;
            output.flush()?;
            return Ok(ExitCode::SUCCESS);
        }
        let mut reader = SessionReader::new(
            io::BufReader::new(io::stdin().lock()),
            SessionWireLimits {
                max_control_bytes: self.max_control_bytes,
                max_payload_bytes: self.max_payload_bytes,
            },
        )?;
        let limits = DecodeLimits::from(self.limits);
        limits.validate()?;
        if self.timeout_ms == 0 {
            return Err("session timeout must be positive".into());
        }
        if (self.native_readback_export || self.native_shared_export || self.native_export)
            && self.encoder.max_encoder_batch_bytes > self.max_payload_bytes as u64
        {
            return Err("encoder output batch exceeds session payload limit".into());
        }
        let mut worker = Worker {
            export: None,
            registry: ResourceRegistry::new(ResourceLimits {
                budget_bytes: self.resource_byte_budget,
                max_resources: self.max_session_resources,
                max_leases: 1,
            })?,
            textures: self.textures.session()?,
            media: self.media.session(&limits)?,
            limits,
            renderer: None,
            dxcompiler: self.dxcompiler,
            gpu_budget_bytes: self.gpu_budget_bytes,
            layer_cache_bytes: self.layer_cache_bytes,
            effect_pipeline_entries: self.effect_pipeline_entries,
            gpu_timestamps: self.gpu_timestamps,
            timeout: Duration::from_millis(self.timeout_ms),
            encoder: self.encoder,
            native_readback_export: self.native_readback_export,
            native_shared_export: self.native_shared_export,
            native_export: self.native_export,
        };
        loop {
            let packet = match reader.read_packet() {
                Ok(Some(packet)) => packet,
                Ok(None) => return Ok(ExitCode::SUCCESS),
                Err(error) => {
                    Reply::write(
                        &mut output,
                        self.max_control_bytes,
                        None,
                        ReplyBody::Error {
                            code: error.code().into(),
                            message: error.to_string(),
                            terminal: true,
                        },
                        &[],
                    )?;
                    return Ok(ExitCode::from(2));
                }
            };
            let id = packet.request.request_id;
            let shutdown = matches!(packet.request.command, SessionCommand::Shutdown {});
            let (response, payload) = match worker.handle(packet.request.command, packet.payload) {
                Ok(response) => response,
                Err(error) => {
                    if let Some(mut export) = worker.export.take() {
                        export.encoder.cancel();
                    }
                    (
                        ReplyBody::Error {
                            code: "request_rejected".into(),
                            message: error.to_string(),
                            terminal: false,
                        },
                        Vec::new(),
                    )
                }
            };
            Reply::write(
                &mut output,
                self.max_control_bytes,
                Some(id),
                response,
                &payload,
            )?;
            if shutdown {
                return Ok(ExitCode::SUCCESS);
            }
        }
    }
}

impl Worker {
    fn handle(
        &mut self,
        command: SessionCommand,
        payload: Vec<u8>,
    ) -> Result<(ReplyBody, Vec<u8>), Box<dyn std::error::Error>> {
        match command {
            SessionCommand::BeginExport { video, frame_count } => self
                .begin_export(video, frame_count)
                .map(|body| (body, Vec::new())),
            SessionCommand::RenderFrame { frame_index, .. } => {
                self.render_export(Some(frame_index), payload)
            }
            SessionCommand::WarmFrame { .. } => self.render_export(None, payload),
            SessionCommand::FinishExport {} => self.finish_export(),
            SessionCommand::CancelExport {} => {
                let encoder = self.export.take().map(|mut export| {
                    export.encoder.cancel();
                    export.encoder.statistics()
                });
                Ok((ReplyBody::ExportCancelled { encoder }, Vec::new()))
            }
            command => self
                .control(command, payload)
                .map(|body| (body, Vec::new())),
        }
    }

    fn control(
        &mut self,
        command: SessionCommand,
        payload: Vec<u8>,
    ) -> Result<ReplyBody, Box<dyn std::error::Error>> {
        match command {
            SessionCommand::PutResource { resource, .. } => {
                let outcome = self.registry.put(resource, payload)?;
                Ok(ReplyBody::ResourceStored {
                    inserted: outcome == PutOutcome::Inserted,
                    usage: self.registry.statistics(),
                })
            }
            SessionCommand::EvictResource { hash } => {
                self.registry.evict(&hash)?;
                Ok(ReplyBody::ResourceEvicted {
                    usage: self.registry.statistics(),
                })
            }
            SessionCommand::CheckFrame { .. } => {
                let digest = format!("{:x}", Sha256::digest(&payload));
                let plan = FplnCodec::decode(payload, &self.limits)?;
                let header = plan.metadata.header.clone();
                let mut inputs = inputs::FrameInputs::install(self, &plan)?;
                let validated = SuppliedFrame::with_textures(
                    plan,
                    &self.registry,
                    &self.limits,
                    &inputs.media.pixels,
                    &inputs.textures.pixels,
                );
                inputs.release(&mut self.registry)?;
                validated?;
                Ok(ReplyBody::FrameChecked {
                    plan_sha256: digest,
                    header,
                    usage: self.registry.statistics(),
                })
            }
            SessionCommand::Probe {
                adapter_luid,
                video,
            } => {
                video.validate(&self.limits)?;
                if !cfg!(windows) {
                    return Err(
                        "native H.264 export currently requires Windows Media Foundation".into(),
                    );
                }
                if let Some(renderer) = &self.renderer {
                    if adapter_luid.is_some() && renderer.adapter_luid() != adapter_luid {
                        return Err("session adapter cannot change".into());
                    }
                } else {
                    self.renderer = Some(NativeRenderer::new_for_adapter(
                        NativeOptions {
                            backend: NativeBackend::Dx12,
                            adapter_name: None,
                            dxcompiler: self.dxcompiler.clone(),
                            gpu_budget_bytes: self.gpu_budget_bytes,
                            layer_cache_bytes: self.layer_cache_bytes,
                            effect_pipeline_entries: self.effect_pipeline_entries,
                            gpu_timestamps: self.gpu_timestamps,
                            effect_regions: true,
                            timeout: self.timeout,
                        },
                        adapter_luid,
                    )?);
                }
                let renderer = self.renderer.as_ref().ok_or("native renderer missing")?;
                let luid = renderer
                    .adapter_luid()
                    .ok_or("native device has no DX12 LUID")?;
                let encoder = HardwareEncoderProbe::inspect(luid, &video, &self.encoder.probe)?;
                let adapter: AdapterDiagnostics = renderer.diagnostics.clone();
                let mut reasons = vec![
                    "Production job preflight, render queue routing and export acceptance are not complete".into(),
                ];
                if !encoder.test_frame_verified {
                    reasons.push(
                        "No adapter-matched hardware encoder produced ordered test frames".into(),
                    );
                }
                Ok(ReplyBody::Capabilities {
                    adapter,
                    adapter_luid: luid,
                    encoder,
                    export_available: false,
                    reasons,
                })
            }
            SessionCommand::Shutdown {} => Ok(ReplyBody::Closed {}),
            _ => Err("export command must use the stream handler".into()),
        }
    }
}

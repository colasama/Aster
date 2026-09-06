use crate::{
    plugin_registry::PluginRegistryCatalog, plugins::PluginHost, project_storage::ProjectStorage,
};
use aster_core::Project;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, BufRead, Write},
    path::PathBuf,
    time::Instant,
};

#[derive(clap::Parser)]
pub struct BridgeOptions {
    #[arg(long)]
    app_data_dir: PathBuf,
    #[command(flatten)]
    bundle_limits: aster_project::BundleLimits,
    #[command(flatten)]
    media_limits: crate::project_media::MediaLimits,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererCapabilities {
    architecture: &'static str,
    backends: [&'static str; 3],
    shader_language: &'static str,
    project_schema: u32,
}

impl Default for RendererCapabilities {
    fn default() -> Self {
        RendererCapabilities {
            architecture: "GPU-first render graph",
            backends: ["Vulkan", "Metal", "DirectX 12"],
            shader_language: "WGSL",
            project_schema: Project::SCHEMA_VERSION,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    id: u64,
    command: String,
    #[serde(default)]
    args: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct BridgeRuntime {
    storage: ProjectStorage,
    plugins: PluginHost,
}

#[derive(Deserialize)]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
struct ProjectArgs {
    path: String,
    project: serde_json::Value,
}

#[derive(Deserialize)]
struct BundleDestinationArgs {
    bundle: String,
    destination: String,
}

#[derive(Deserialize)]
struct ArchiveParentArgs {
    archive: String,
    parent: String,
}

#[derive(Deserialize)]
struct LinkAssetArgs {
    bundle: String,
    source: String,
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderFrameArgs {
    directory: String,
    file_name: String,
    data: String,
}

#[derive(Deserialize)]
struct SourceArgs {
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginEnabledArgs {
    plugin_id: String,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginRuntimeArgs {
    plugin_ids: BTreeSet<String>,
}

#[derive(Deserialize)]
struct EnabledArgs {
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SafeModeArgs {
    safe_mode: bool,
}

impl BridgeOptions {
    pub fn run(self) -> Result<(), String> {
        fs::create_dir_all(&self.app_data_dir).map_err(|error| error.to_string())?;
        let mut runtime = BridgeRuntime {
            storage: ProjectStorage {
                media: crate::project_media::ProjectMedia {
                    limits: self.media_limits,
                },
                bundle_limits: self.bundle_limits,
            },
            plugins: PluginHost {
                app_data: self.app_data_dir,
                runtime: Default::default(),
            },
        };
        tracing::info!(
            event = "bridge_started",
            session_id = std::env::var("ASTER_SESSION_ID").unwrap_or_else(|_| "standalone".to_owned()),
            app_data = %runtime.plugins.app_data.display(),
            "desktop bridge is ready"
        );
        let stdin = io::stdin();
        let mut stdout = io::BufWriter::new(io::stdout().lock());
        for line in stdin.lock().lines() {
            let line = line.map_err(|error| error.to_string())?;
            if line.trim().is_empty() {
                continue;
            }
            let request = match serde_json::from_str::<BridgeRequest>(&line) {
                Ok(request) => request,
                Err(error) => {
                    tracing::warn!(
                        event = "invalid_request",
                        error = %error,
                        "desktop bridge rejected malformed JSON"
                    );
                    let response = BridgeResponse {
                        id: 0,
                        result: None,
                        error: Some(format!("invalid bridge request: {error}")),
                    };
                    serde_json::to_writer(&mut stdout, &response)
                        .map_err(|error| error.to_string())?;
                    writeln!(&mut stdout).map_err(|error| error.to_string())?;
                    stdout.flush().map_err(|error| error.to_string())?;
                    continue;
                }
            };
            let id = request.id;
            let command = request.command.clone();
            let started = Instant::now();
            if !matches!(
                command.as_str(),
                "poll_plugin_hot_reload" | "save_render_frame"
            ) {
                tracing::debug!(
                    event = "command_started",
                    request_id = id,
                    command = %command,
                    "desktop command started"
                );
            }
            let response = match runtime.dispatch(request) {
                Ok(result) => {
                    if !matches!(
                        command.as_str(),
                        "poll_plugin_hot_reload" | "save_render_frame"
                    ) {
                        tracing::debug!(
                            event = "command_completed",
                            request_id = id,
                            command = %command,
                            duration_ms = started.elapsed().as_secs_f64() * 1_000.0,
                            "desktop command completed"
                        );
                    }
                    BridgeResponse {
                        id,
                        result: Some(result),
                        error: None,
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        event = "command_failed",
                        request_id = id,
                        command = %command,
                        duration_ms = started.elapsed().as_secs_f64() * 1_000.0,
                        error = %error,
                        "desktop command failed"
                    );
                    BridgeResponse {
                        id,
                        result: None,
                        error: Some(error),
                    }
                }
            };
            serde_json::to_writer(&mut stdout, &response).map_err(|error| error.to_string())?;
            writeln!(&mut stdout).map_err(|error| error.to_string())?;
            stdout.flush().map_err(|error| error.to_string())?;
        }
        tracing::info!(event = "bridge_stopped", "desktop bridge input closed");
        Ok(())
    }
}
impl BridgeRuntime {
    fn dispatch(&mut self, request: BridgeRequest) -> Result<serde_json::Value, String> {
        let BridgeRequest { command, args, .. } = request;
        match command.as_str() {
            "renderer_capabilities" => serde_json::to_value(RendererCapabilities::default())
                .map_err(|error| error.to_string()),
            "save_project" => {
                let args: ProjectArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                self.storage.save_project(args.path, args.project)?;
                Ok(serde_json::Value::Null)
            }
            "load_project" => {
                let args: PathArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                self.storage.load_project(args.path)
            }
            "pack_project" => {
                let args: BundleDestinationArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                self.storage
                    .bundle(args.bundle)
                    .pack(args.destination)
                    .map_err(|error| error.to_string())?;
                Ok(serde_json::Value::Null)
            }
            "unpack_project" => {
                let args: ArchiveParentArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                let result = self.storage.unpack_project(args.archive, args.parent)?;
                serde_json::to_value(result).map_err(|error| error.to_string())
            }
            "link_project_asset" => {
                let args: LinkAssetArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                let result = ProjectStorage::link_asset(&args.bundle, &args.source, &args.kind)?;
                serde_json::to_value(result).map_err(|error| error.to_string())
            }
            "save_autosave" => {
                let args: ProjectArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                self.storage.save_autosave(args.path, args.project)?;
                Ok(serde_json::Value::Null)
            }
            "recovery_candidate" => {
                let args: PathArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                let result = self.storage.recovery_candidate(args.path)?;
                serde_json::to_value(result).map_err(|error| error.to_string())
            }
            "clear_autosave" => {
                let args: PathArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                self.storage
                    .bundle(args.path)
                    .clear_autosave()
                    .map_err(|error| error.to_string())?;
                Ok(serde_json::Value::Null)
            }
            "save_render_frame" => {
                let args: RenderFrameArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                ProjectStorage::write_render_frame(&args.directory, &args.file_name, &args.data)?;
                Ok(serde_json::Value::Null)
            }
            "plugin_registry_catalog" => serde_json::to_value(PluginRegistryCatalog::from_bytes(
                PluginRegistryCatalog::DEVELOPMENT_INDEX,
                aster_plugin::HOST_PLUGIN_API_VERSION,
            )?)
            .map_err(|error| error.to_string()),
            "plugin_status" => {
                serde_json::to_value(self.plugins.status(false)?).map_err(|error| error.to_string())
            }
            "load_plugin_runtime" => {
                let args: PluginRuntimeArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                serde_json::to_value(self.plugins.load_plugin_runtime(args.plugin_ids)?)
                    .map_err(|error| error.to_string())
            }
            "poll_plugin_hot_reload" => {
                serde_json::to_value(self.plugins.status(false)?).map_err(|error| error.to_string())
            }
            "install_plugin" => {
                let args: SourceArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                serde_json::to_value(self.plugins.install_plugin(args.source)?)
                    .map_err(|error| error.to_string())
            }
            "set_plugin_enabled" => {
                let args: PluginEnabledArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                serde_json::to_value(
                    self.plugins
                        .set_plugin_enabled(args.plugin_id, args.enabled)?,
                )
                .map_err(|error| error.to_string())
            }
            "set_plugin_safe_mode" => {
                let args: SafeModeArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                serde_json::to_value(self.plugins.set_plugin_safe_mode(args.safe_mode)?)
                    .map_err(|error| error.to_string())
            }
            "set_plugin_hot_reload" => {
                let args: EnabledArgs = serde_json::from_value(args)
                    .map_err(|error| format!("invalid command arguments: {error}"))?;
                serde_json::to_value(self.plugins.set_plugin_hot_reload(args.enabled)?)
                    .map_err(|error| error.to_string())
            }
            _ => Err(format!("unsupported desktop command `{command}`")),
        }
    }
}

use aster_core::Project;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, fs, path::PathBuf};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererCapabilities {
    architecture: &'static str,
    backends: [&'static str; 3],
    shader_language: &'static str,
    project_schema: u32,
}

#[tauri::command]
fn renderer_capabilities() -> RendererCapabilities {
    let _ = aster_render::preferred_backends();
    RendererCapabilities {
        architecture: "GPU-first render graph",
        backends: ["Vulkan", "Metal", "DirectX 12"],
        shader_language: "WGSL",
        project_schema: Project::SCHEMA_VERSION,
    }
}

#[tauri::command]
fn operation_schema() -> Result<serde_json::Value, String> {
    aster_ai::operation_schema().map_err(|error| error.to_string())
}

#[tauri::command]
async fn generate_ai_plan(
    config: aster_ai::AiProviderConfig,
    prompt: String,
    project_summary: String,
) -> Result<aster_ai::GeneratedPlan, String> {
    aster_ai::generate_plan(config, &prompt, &project_summary)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn save_project(path: String, project: serde_json::Value) -> Result<(), String> {
    aster_project::save_editor_bundle(path, &project).map_err(|error| error.to_string())
}

#[tauri::command]
fn load_project(path: String) -> Result<serde_json::Value, String> {
    aster_project::load_editor_bundle(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_autosave(path: String, project: serde_json::Value) -> Result<(), String> {
    aster_project::save_autosave(path, &project).map_err(|error| error.to_string())
}

#[tauri::command]
fn recovery_candidate(path: String) -> Result<Option<serde_json::Value>, String> {
    aster_project::recovery_candidate(path).map_err(|error| error.to_string())
}

#[tauri::command]
fn clear_autosave(path: String) -> Result<(), String> {
    aster_project::clear_autosave(path).map_err(|error| error.to_string())
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct PluginPreferences {
    safe_mode: bool,
    disabled: BTreeSet<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginStatus {
    directory: PathBuf,
    safe_mode: bool,
    disabled: BTreeSet<String>,
    report: aster_plugin::DiscoveryReport,
}

#[tauri::command]
fn plugin_status(app: tauri::AppHandle) -> Result<PluginStatus, String> {
    let root = plugin_root(&app)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let preferences = read_plugin_preferences(&app)?;
    let report = aster_plugin::discover(&root).map_err(|error| error.to_string())?;
    Ok(PluginStatus {
        directory: root,
        safe_mode: preferences.safe_mode,
        disabled: preferences.disabled,
        report,
    })
}

#[tauri::command]
fn install_plugin(app: tauri::AppHandle, source: String) -> Result<PluginStatus, String> {
    let root = plugin_root(&app)?;
    aster_plugin::install(source, root).map_err(|error| error.to_string())?;
    plugin_status(app)
}

#[tauri::command]
fn set_plugin_enabled(
    app: tauri::AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginStatus, String> {
    let root = plugin_root(&app)?;
    let report = aster_plugin::discover(&root).map_err(|error| error.to_string())?;
    if !report
        .plugins
        .iter()
        .any(|manifest| manifest.plugin.id == plugin_id)
    {
        return Err(format!("plugin `{plugin_id}` is not installed"));
    }
    let mut preferences = read_plugin_preferences(&app)?;
    if enabled {
        preferences.disabled.remove(&plugin_id);
    } else {
        preferences.disabled.insert(plugin_id);
    }
    write_plugin_preferences(&app, &preferences)?;
    plugin_status(app)
}

#[tauri::command]
fn set_plugin_safe_mode(app: tauri::AppHandle, safe_mode: bool) -> Result<PluginStatus, String> {
    let mut preferences = read_plugin_preferences(&app)?;
    preferences.safe_mode = safe_mode;
    write_plugin_preferences(&app, &preferences)?;
    plugin_status(app)
}

fn plugin_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("plugins"))
        .map_err(|error| error.to_string())
}

fn plugin_preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("plugin-preferences.json"))
        .map_err(|error| error.to_string())
}

fn read_plugin_preferences(app: &tauri::AppHandle) -> Result<PluginPreferences, String> {
    let path = plugin_preferences_path(app)?;
    if !path.exists() {
        return Ok(PluginPreferences::default());
    }
    let source = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&source).map_err(|error| error.to_string())
}

fn write_plugin_preferences(
    app: &tauri::AppHandle,
    preferences: &PluginPreferences,
) -> Result<(), String> {
    let path = plugin_preferences_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "plugin preferences path has no parent".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    let backup = path.with_extension("json.backup");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(preferences).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        fs::rename(&path, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.exists() {
            let _ = fs::rename(&backup, &path);
        }
        return Err(error.to_string());
    }
    if backup.exists() {
        fs::remove_file(backup).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            clear_autosave,
            generate_ai_plan,
            load_project,
            install_plugin,
            operation_schema,
            plugin_status,
            recovery_candidate,
            renderer_capabilities,
            save_autosave,
            save_project,
            set_plugin_enabled,
            set_plugin_safe_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

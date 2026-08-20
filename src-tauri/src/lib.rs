use aster_core::Project;
use base64::Engine;
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
async fn save_project(path: String, project: serde_json::Value) -> Result<(), String> {
    blocking_io(move || {
        aster_project::save_editor_bundle(path, &project).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn load_project(path: String) -> Result<serde_json::Value, String> {
    blocking_io(move || aster_project::load_editor_bundle(path).map_err(|error| error.to_string()))
        .await
}

#[tauri::command]
async fn save_autosave(path: String, project: serde_json::Value) -> Result<(), String> {
    blocking_io(move || {
        aster_project::save_autosave(path, &project).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn recovery_candidate(path: String) -> Result<Option<serde_json::Value>, String> {
    blocking_io(move || aster_project::recovery_candidate(path).map_err(|error| error.to_string()))
        .await
}

#[tauri::command]
async fn clear_autosave(path: String) -> Result<(), String> {
    blocking_io(move || aster_project::clear_autosave(path).map_err(|error| error.to_string()))
        .await
}

#[tauri::command]
async fn save_render_frame(
    directory: String,
    file_name: String,
    data: String,
) -> Result<(), String> {
    blocking_io(move || write_render_frame(&directory, &file_name, &data)).await
}

async fn blocking_io<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("background I/O task failed: {error}"))?
}

fn write_render_frame(directory: &str, file_name: &str, data: &str) -> Result<(), String> {
    if !valid_render_frame_name(file_name) {
        return Err("render frame name must match frame_000001.png".to_owned());
    }
    let directory = PathBuf::from(directory);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| error.to_string())?;
    let destination = directory.join(file_name);
    let temporary = directory.join(format!(".{file_name}.tmp"));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    if destination.exists() {
        fs::remove_file(&destination).map_err(|error| error.to_string())?;
    }
    fs::rename(temporary, destination).map_err(|error| error.to_string())
}

fn valid_render_frame_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 16
        && bytes.starts_with(b"frame_")
        && bytes.ends_with(b".png")
        && bytes[6..12].iter().all(u8::is_ascii_digit)
}

#[cfg(test)]
mod tests {
    use super::{valid_render_frame_name, write_render_frame};
    use std::fs;

    #[test]
    fn render_frame_names_cannot_escape_the_selected_directory() {
        assert!(valid_render_frame_name("frame_000001.png"));
        assert!(!valid_render_frame_name("../frame_000001.png"));
        assert!(!valid_render_frame_name("frame_00001x.png"));
        assert!(!valid_render_frame_name("frame_一00001.png"));
    }

    #[test]
    fn render_frames_are_atomically_written() {
        let directory =
            std::env::temp_dir().join(format!("aster-render-frame-test-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("create render test directory");

        write_render_frame(
            &directory.to_string_lossy(),
            "frame_000001.png",
            "iVBORw0KGgo=",
        )
        .expect("save render frame");

        assert_eq!(
            fs::read(directory.join("frame_000001.png")).expect("read render frame"),
            [137, 80, 78, 71, 13, 10, 26, 10]
        );
        assert!(!directory.join(".frame_000001.png.tmp").exists());
        fs::remove_dir_all(directory).expect("remove render test directory");
    }
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
            save_render_frame,
            set_plugin_enabled,
            set_plugin_safe_mode
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

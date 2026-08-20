use aster_core::Project;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    path::{Component, Path, PathBuf},
};
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
async fn load_project(app: tauri::AppHandle, path: String) -> Result<serde_json::Value, String> {
    let (project, assets) = blocking_io(move || load_project_assets(&path)).await?;
    for asset in assets {
        app.asset_protocol_scope()
            .allow_file(asset)
            .map_err(|error| error.to_string())?;
    }
    Ok(project)
}

#[tauri::command]
async fn pack_project(bundle: String, destination: String) -> Result<(), String> {
    blocking_io(move || {
        aster_project::pack_editor_bundle(bundle, destination).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn unpack_project(archive: String, parent: String) -> Result<String, String> {
    blocking_io(move || {
        let archive = PathBuf::from(archive)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let parent = PathBuf::from(parent)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !archive.is_file() || !parent.is_dir() {
            return Err("packed project source and destination must exist".to_owned());
        }
        let stem = archive
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("Aster Project");
        let sanitized: String = stem
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || " -_".contains(character) {
                    character
                } else {
                    '-'
                }
            })
            .take(100)
            .collect();
        let base = if sanitized.trim().is_empty() {
            "Aster Project"
        } else {
            sanitized.trim()
        };
        let mut destination = parent.join(base);
        for suffix in 2..10_000 {
            if !destination.exists() {
                break;
            }
            destination = parent.join(format!("{base}-{suffix}"));
        }
        if destination.exists() {
            return Err("unable to allocate an unpacked project directory".to_owned());
        }
        aster_project::unpack_editor_bundle(&archive, &destination)
            .map_err(|error| error.to_string())?;
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedProjectAsset {
    relative_path: String,
    resolved_path: PathBuf,
    name: String,
}

#[tauri::command]
async fn link_project_asset(
    app: tauri::AppHandle,
    bundle: String,
    source: String,
    kind: String,
) -> Result<LinkedProjectAsset, String> {
    let linked = blocking_io(move || link_asset(&bundle, &source, &kind)).await?;
    app.asset_protocol_scope()
        .allow_file(&linked.resolved_path)
        .map_err(|error| error.to_string())?;
    Ok(linked)
}

#[tauri::command]
async fn save_autosave(path: String, project: serde_json::Value) -> Result<(), String> {
    blocking_io(move || {
        aster_project::save_autosave(path, &project).map_err(|error| error.to_string())
    })
    .await
}

#[tauri::command]
async fn recovery_candidate(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<serde_json::Value>, String> {
    let (candidate, assets) = blocking_io(move || {
        let bundle = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut candidate =
            aster_project::recovery_candidate(&bundle).map_err(|error| error.to_string())?;
        let assets = match candidate.as_mut() {
            Some(project) => resolve_project_asset_paths(&bundle, project)?,
            None => Vec::new(),
        };
        Ok((candidate, assets))
    })
    .await?;
    for asset in assets {
        app.asset_protocol_scope()
            .allow_file(asset)
            .map_err(|error| error.to_string())?;
    }
    Ok(candidate)
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

fn load_project_assets(path: &str) -> Result<(serde_json::Value, Vec<PathBuf>), String> {
    let bundle = PathBuf::from(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut project =
        aster_project::load_editor_bundle(&bundle).map_err(|error| error.to_string())?;
    let assets = resolve_project_asset_paths(&bundle, &mut project)?;
    Ok((project, assets))
}

fn resolve_project_asset_paths(
    bundle: &Path,
    project: &mut serde_json::Value,
) -> Result<Vec<PathBuf>, String> {
    let mut assets = Vec::new();
    for composition in project
        .get_mut("compositions")
        .and_then(serde_json::Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        for layer in composition
            .get_mut("layers")
            .and_then(serde_json::Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let Some(asset) = layer
                .get_mut("asset")
                .and_then(serde_json::Value::as_object_mut)
            else {
                continue;
            };
            let Some(relative) = asset
                .get("relativePath")
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let candidate = bundle.join(safe_relative_path(relative)?);
            if !candidate.is_file() {
                continue;
            }
            let resolved = candidate
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !resolved.starts_with(bundle) {
                return Err("relative asset resolves outside the project bundle".to_owned());
            }
            asset.insert(
                "resolvedPath".to_owned(),
                serde_json::Value::String(resolved.to_string_lossy().into_owned()),
            );
            assets.push(resolved);
        }
    }
    Ok(assets)
}

fn link_asset(bundle: &str, source: &str, kind: &str) -> Result<LinkedProjectAsset, String> {
    let bundle = PathBuf::from(bundle)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let source = PathBuf::from(source)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !source.is_file() || !valid_asset_extension(&source, kind) {
        return Err(format!("selected file is not a supported {kind} asset"));
    }
    let resolved = if source.starts_with(&bundle) {
        source
    } else {
        let assets = bundle.join("assets");
        fs::create_dir_all(&assets).map_err(|error| error.to_string())?;
        let destination = available_asset_destination(&assets, &source);
        fs::copy(&source, &destination).map_err(|error| error.to_string())?;
        fs::OpenOptions::new()
            .write(true)
            .open(&destination)
            .and_then(|file| file.sync_all())
            .map_err(|error| error.to_string())?;
        destination
            .canonicalize()
            .map_err(|error| error.to_string())?
    };
    let relative = resolved
        .strip_prefix(&bundle)
        .map_err(|_| "linked asset must stay inside the project bundle".to_owned())?;
    let relative_path = relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    Ok(LinkedProjectAsset {
        relative_path,
        name: resolved
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("asset")
            .to_owned(),
        resolved_path: resolved,
    })
}

fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
    {
        return Err("asset relativePath must stay inside the project bundle".to_owned());
    }
    Ok(path.to_owned())
}

fn valid_asset_extension(path: &Path, kind: &str) -> bool {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match kind {
        "image" => {
            ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"].contains(&extension.as_str())
        }
        "video" => ["mp4", "webm", "mov", "m4v", "ogv"].contains(&extension.as_str()),
        _ => false,
    }
}

fn available_asset_destination(directory: &Path, source: &Path) -> PathBuf {
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("asset.bin");
    let sanitized: String = file_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || ".-_".contains(character) {
                character
            } else {
                '-'
            }
        })
        .take(160)
        .collect();
    let initial = directory.join(&sanitized);
    if !initial.exists() {
        return initial;
    }
    let path = Path::new(&sanitized);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("asset");
    let extension = path.extension().and_then(|extension| extension.to_str());
    for index in 2..10_000 {
        let name = match extension {
            Some(extension) => format!("{stem}-{index}.{extension}"),
            None => format!("{stem}-{index}"),
        };
        let candidate = directory.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("asset-{}", std::process::id()))
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
    use super::{link_asset, safe_relative_path, valid_render_frame_name, write_render_frame};
    use std::fs;

    #[test]
    fn render_frame_names_cannot_escape_the_selected_directory() {
        assert!(valid_render_frame_name("frame_000001.png"));
        assert!(!valid_render_frame_name("../frame_000001.png"));
        assert!(!valid_render_frame_name("frame_00001x.png"));
        assert!(!valid_render_frame_name("frame_一00001.png"));
    }

    #[test]
    fn relative_assets_cannot_escape_the_project_bundle() {
        assert!(safe_relative_path("assets/plate.png").is_ok());
        assert!(safe_relative_path("../secret.txt").is_err());
        assert!(safe_relative_path("C:\\secret.txt").is_err());
        assert!(safe_relative_path("/etc/passwd").is_err());
    }

    #[test]
    fn linked_assets_are_copied_inside_the_project_bundle() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("aster-link-test-{suffix}"));
        let bundle = root.join("project");
        fs::create_dir_all(&bundle).expect("create project bundle");
        let source = root.join("plate.png");
        fs::write(&source, [1, 2, 3, 4]).expect("write source asset");

        let linked = link_asset(
            &bundle.to_string_lossy(),
            &source.to_string_lossy(),
            "image",
        )
        .expect("link project asset");
        assert_eq!(linked.relative_path, "assets/plate.png");
        assert_eq!(
            fs::read(linked.resolved_path).expect("read linked asset"),
            [1, 2, 3, 4]
        );
        fs::remove_dir_all(root).expect("remove link test directory");
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
            link_project_asset,
            pack_project,
            install_plugin,
            operation_schema,
            plugin_status,
            recovery_candidate,
            renderer_capabilities,
            save_autosave,
            save_project,
            save_render_frame,
            set_plugin_enabled,
            set_plugin_safe_mode,
            unpack_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

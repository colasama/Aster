use aster_core::Project;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, BufRead, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::Instant,
};

mod logging;
mod plugin_registry;
mod project_media;
use plugin_registry::plugin_registry_catalog;
use project_media::{materialize_project_media, resolve_project_media_paths};

pub use logging::init as init_logging;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RendererCapabilities {
    architecture: &'static str,
    backends: [&'static str; 3],
    shader_language: &'static str,
    project_schema: u32,
}

fn renderer_capabilities() -> RendererCapabilities {
    let _ = aster_render::preferred_backends();
    RendererCapabilities {
        architecture: "GPU-first render graph",
        backends: ["Vulkan", "Metal", "DirectX 12"],
        shader_language: "WGSL",
        project_schema: Project::SCHEMA_VERSION,
    }
}

async fn save_project(path: String, mut project: serde_json::Value) -> Result<(), String> {
    blocking_io(move || {
        let bundle = PathBuf::from(path);
        aster_project::validate_editor_project(&project).map_err(|error| error.to_string())?;
        materialize_project_media(&bundle, &mut project)?;
        aster_project::save_editor_bundle(bundle, &project).map_err(|error| error.to_string())
    })
    .await
}

async fn load_project(path: String) -> Result<serde_json::Value, String> {
    let (project, _) = blocking_io(move || load_project_assets(&path)).await?;
    Ok(project)
}

async fn pack_project(bundle: String, destination: String) -> Result<(), String> {
    blocking_io(move || {
        aster_project::pack_editor_bundle(bundle, destination).map_err(|error| error.to_string())
    })
    .await
}

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
    content_identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    media_metadata: Option<LinkedMediaMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedMediaMetadata {
    duration: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio: Option<LinkedAudioMetadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LinkedAudioMetadata {
    stream_index: u32,
    channels: u8,
    sample_rate: u32,
}

async fn link_project_asset(
    bundle: String,
    source: String,
    kind: String,
) -> Result<LinkedProjectAsset, String> {
    blocking_io(move || link_asset(&bundle, &source, &kind)).await
}

async fn save_autosave(path: String, mut project: serde_json::Value) -> Result<(), String> {
    blocking_io(move || {
        let bundle = PathBuf::from(path);
        aster_project::validate_editor_project(&project).map_err(|error| error.to_string())?;
        materialize_project_media(&bundle, &mut project)?;
        aster_project::save_autosave(bundle, &project).map_err(|error| error.to_string())
    })
    .await
}

async fn recovery_candidate(path: String) -> Result<Option<serde_json::Value>, String> {
    let (candidate, assets) = blocking_io(move || {
        let bundle = PathBuf::from(path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut candidate =
            aster_project::recovery_candidate(&bundle).map_err(|error| error.to_string())?;
        let assets = match candidate.as_mut() {
            Some(project) => {
                let mut assets = resolve_project_asset_paths(&bundle, project)?;
                assets.extend(resolve_project_media_paths(&bundle, project)?);
                assets
            }
            None => Vec::new(),
        };
        Ok((candidate, assets))
    })
    .await?;
    let _ = assets;
    Ok(candidate)
}

async fn clear_autosave(path: String) -> Result<(), String> {
    blocking_io(move || aster_project::clear_autosave(path).map_err(|error| error.to_string()))
        .await
}

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
    tokio::task::spawn_blocking(operation)
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
    let mut assets = resolve_project_asset_paths(&bundle, &mut project)?;
    assets.extend(resolve_project_media_paths(&bundle, &mut project)?);
    Ok((project, assets))
}

fn resolve_project_asset_paths(
    bundle: &Path,
    project: &mut serde_json::Value,
) -> Result<Vec<PathBuf>, String> {
    let mut assets = Vec::new();
    for source in project
        .get_mut("sources")
        .and_then(serde_json::Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        let Some(source) = source.as_object_mut() else {
            continue;
        };
        let Some(relative) = source
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
        source.insert(
            "resolvedPath".to_owned(),
            serde_json::Value::String(resolved.to_string_lossy().into_owned()),
        );
        assets.push(resolved);
    }
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
    let content_identity = sha256_file_identity(&resolved)?;
    let media_metadata = probe_linked_media(&resolved, kind)?;
    Ok(LinkedProjectAsset {
        relative_path,
        name: resolved
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("asset")
            .to_owned(),
        content_identity,
        media_metadata,
        resolved_path: resolved,
    })
}

fn probe_linked_media(path: &Path, kind: &str) -> Result<Option<LinkedMediaMetadata>, String> {
    if kind != "audio" && kind != "video" {
        return Ok(None);
    }
    let metadata = aster_video::FfprobeBackend::default()
        .probe(path, &aster_video::CancellationToken::default())
        .map_err(|error| format!("unable to inspect linked {kind} metadata: {error}"))?;
    let duration = metadata.timebase.seconds(metadata.duration_ticks);
    if !duration.is_finite() || duration <= 0.0 || duration > 86_400.0 {
        return Err("linked media duration exceeds the supported range".to_owned());
    }
    let audio = aster_video::select_audio_stream(&metadata)
        .ok()
        .map(|stream| LinkedAudioMetadata {
            stream_index: stream.index,
            channels: stream.channels,
            sample_rate: stream.sample_rate,
        });
    if kind == "audio" && audio.is_none() {
        return Err("linked audio file has no usable audio stream".to_owned());
    }
    let video = if kind == "video" {
        Some(aster_video::select_video_stream(&metadata).map_err(|error| error.to_string())?)
    } else {
        None
    };
    Ok(Some(LinkedMediaMetadata {
        duration,
        width: video.map(|stream| stream.width),
        height: video.map(|stream| stream.height),
        audio,
    }))
}

fn sha256_file_identity(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("sha256:{:x}", digest.finalize()))
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
        "audio" => ["wav", "mp3", "aac", "m4a", "ogg", "flac"].contains(&extension.as_str()),
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
    use super::{
        link_asset, load_project, pack_project, read_plugin_preferences, recovery_candidate,
        safe_relative_path, save_autosave, save_project, sha256_file_identity, unpack_project,
        valid_render_frame_name, write_render_frame,
    };
    use serde_json::json;
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
            linked.content_identity,
            sha256_file_identity(&source).unwrap()
        );
        assert_eq!(
            fs::read(linked.resolved_path).expect("read linked asset"),
            [1, 2, 3, 4]
        );
        fs::remove_dir_all(root).expect("remove link test directory");
    }

    #[test]
    fn advanced_media_survives_save_recovery_and_pack_without_its_original() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("create test runtime")
            .block_on(advanced_media_lifecycle());
    }

    async fn advanced_media_lifecycle() {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("aster-media-lifecycle-{suffix}"));
        let bundle = root.join("project");
        let unpack_parent = root.join("unpacked");
        let archive = root.join("packed.aster");
        let original = root.join("original.svg");
        fs::create_dir_all(&unpack_parent).expect("create unpack parent");
        let bytes = b"<svg viewBox=\"0 0 10 10\"/>";
        fs::write(&original, bytes).expect("write original media");
        let identity = test_fnv64_identity(bytes);
        let project = json!({
            "schemaVersion": 10,
            "activeCompositionId": "main",
            "compositions": [{ "id": "main", "layers": [] }],
            "mediaImports": {
                "version": 1,
                "entries": [{ "sourceId": "svg", "kind": "svg", "contentIdentity": identity, "payloadId": "svg:payload" }],
                "payloads": [{
                    "id": "svg:payload",
                    "kind": "svg",
                    "contentIdentity": identity,
                    "width": 10,
                    "height": 10,
                    "storage": { "kind": "external", "externalPath": original, "byteIdentity": identity }
                }]
            }
        });

        save_project(bundle.to_string_lossy().into_owned(), project)
            .await
            .expect("save project");
        fs::remove_file(&original).expect("remove original media");
        let persisted = fs::read_to_string(bundle.join("project.json")).expect("read project");
        assert!(!persisted.contains("externalPath"));
        assert!(!persisted.contains("resolvedPath"));
        assert!(!persisted.contains("\"data\""));

        let loaded = load_project(bundle.to_string_lossy().into_owned())
            .await
            .expect("load project");
        assert!(loaded["mediaImports"]["payloads"][0]["storage"]["resolvedPath"].is_string());
        save_autosave(bundle.to_string_lossy().into_owned(), loaded)
            .await
            .expect("save autosave");
        let recovered = recovery_candidate(bundle.to_string_lossy().into_owned())
            .await
            .expect("read recovery")
            .expect("recovery candidate");
        assert!(recovered["mediaImports"]["payloads"][0]["storage"]["resolvedPath"].is_string());

        pack_project(
            bundle.to_string_lossy().into_owned(),
            archive.to_string_lossy().into_owned(),
        )
        .await
        .expect("pack project");
        let unpacked = unpack_project(
            archive.to_string_lossy().into_owned(),
            unpack_parent.to_string_lossy().into_owned(),
        )
        .await
        .expect("unpack project");
        let packed = load_project(unpacked).await.expect("load packed project");
        assert!(packed["mediaImports"]["payloads"][0]["storage"]["resolvedPath"].is_string());
        fs::remove_dir_all(root).expect("remove lifecycle test directory");
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

    #[test]
    fn legacy_plugin_preferences_are_migrated_to_the_versioned_document() {
        let directory = std::env::temp_dir().join(format!(
            "aster-plugin-preferences-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).expect("create preferences directory");
        fs::write(
            directory.join("plugin-preferences.json"),
            r#"{"safeMode":true,"disabled":["example.effect"]}"#,
        )
        .expect("write legacy preferences");

        let preferences = read_plugin_preferences(&directory).expect("migrate preferences");
        assert_eq!(preferences.schema_version, 1);
        assert!(preferences.safe_mode);
        let persisted: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.join("plugin-preferences.json")).expect("read preferences"),
        )
        .expect("parse preferences");
        assert_eq!(persisted["schemaVersion"], 1);
        fs::remove_dir_all(directory).expect("remove preferences directory");
    }

    fn test_fnv64_identity(bytes: &[u8]) -> String {
        let mut left = 0x811c9dc5_u32;
        let mut right = 0x9e3779b9_u32;
        for byte in bytes {
            left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        format!("fnv64:{left:08x}{right:08x}:{}", bytes.len())
    }
}

const CURRENT_PLUGIN_PREFERENCES_VERSION: u32 = 1;

#[derive(Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct PluginPreferences {
    schema_version: u32,
    safe_mode: bool,
    hot_reload_enabled: bool,
    disabled: BTreeSet<String>,
}

impl Default for PluginPreferences {
    fn default() -> Self {
        Self {
            schema_version: CURRENT_PLUGIN_PREFERENCES_VERSION,
            safe_mode: false,
            hot_reload_enabled: false,
            disabled: BTreeSet::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginStatus {
    directory: PathBuf,
    safe_mode: bool,
    disabled: BTreeSet<String>,
    report: aster_plugin::DiscoveryReport,
    hot_reload: aster_plugin::hot_reload::HotReloadStatus,
}

fn plugin_status(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
) -> Result<PluginStatus, String> {
    plugin_status_inner(app_data, runtime, false)
}

fn poll_plugin_hot_reload(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
) -> Result<PluginStatus, String> {
    plugin_status_inner(app_data, runtime, false)
}

fn plugin_status_inner(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
    force_reload: bool,
) -> Result<PluginStatus, String> {
    let root = plugin_root(app_data);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let preferences = read_plugin_preferences(app_data)?;
    let mut runtime = runtime
        .lock()
        .map_err(|_| "plugin hot reload state is unavailable".to_owned())?;
    let (mut report, hot_reload) = if preferences.hot_reload_enabled && !preferences.safe_mode {
        let view = if force_reload {
            runtime.force_reload(&root)
        } else {
            runtime.poll(&root)
        }
        .map_err(|error| error.to_string())?;
        (view.report, view.status)
    } else {
        let report = aster_plugin::discover_metadata(&root).map_err(|error| error.to_string())?;
        let status = runtime
            .inactive_view(preferences.hot_reload_enabled, preferences.safe_mode)
            .status;
        (report, status)
    };
    report.shader_sources.clear();
    Ok(PluginStatus {
        directory: root.clone(),
        safe_mode: preferences.safe_mode,
        disabled: preferences.disabled,
        report: redact_plugin_report(&root, report),
        hot_reload,
    })
}

fn load_plugin_runtime(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
    plugin_ids: BTreeSet<String>,
) -> Result<PluginStatus, String> {
    if plugin_ids.len() > 256 {
        return Err("too many plugin runtimes requested".to_owned());
    }
    let root = plugin_root(app_data);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let preferences = read_plugin_preferences(app_data)?;
    let requested = if preferences.safe_mode {
        BTreeSet::new()
    } else {
        plugin_ids
            .into_iter()
            .filter(|plugin_id| !preferences.disabled.contains(plugin_id))
            .collect()
    };
    let mut runtime = runtime
        .lock()
        .map_err(|_| "plugin hot reload state is unavailable".to_owned())?;
    let (mut report, hot_reload) = if preferences.hot_reload_enabled && !preferences.safe_mode {
        let view = runtime.poll(&root).map_err(|error| error.to_string())?;
        (view.report, view.status)
    } else {
        let report = aster_plugin::discover_selected(&root, &requested)
            .map_err(|error| error.to_string())?;
        let status = runtime
            .inactive_view(preferences.hot_reload_enabled, preferences.safe_mode)
            .status;
        (report, status)
    };
    report
        .shader_sources
        .retain(|plugin_id, _| requested.contains(plugin_id));
    Ok(PluginStatus {
        directory: root.clone(),
        safe_mode: preferences.safe_mode,
        disabled: preferences.disabled,
        report: redact_plugin_report(&root, report),
        hot_reload,
    })
}

fn install_plugin(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
    source: String,
) -> Result<PluginStatus, String> {
    let root = plugin_root(app_data);
    aster_plugin::install(source, root).map_err(|error| error.to_string())?;
    plugin_status_inner(app_data, runtime, true)
}

fn set_plugin_enabled(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginStatus, String> {
    let root = plugin_root(app_data);
    let report = aster_plugin::discover_metadata(&root).map_err(|error| error.to_string())?;
    if !report
        .plugins
        .iter()
        .any(|manifest| manifest.plugin.id == plugin_id)
    {
        return Err(format!("plugin `{plugin_id}` is not installed"));
    }
    let mut preferences = read_plugin_preferences(app_data)?;
    if enabled {
        preferences.disabled.remove(&plugin_id);
    } else {
        preferences.disabled.insert(plugin_id);
    }
    write_plugin_preferences(app_data, &preferences)?;
    plugin_status_inner(app_data, runtime, false)
}

fn set_plugin_safe_mode(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
    safe_mode: bool,
) -> Result<PluginStatus, String> {
    let mut preferences = read_plugin_preferences(app_data)?;
    preferences.safe_mode = safe_mode;
    write_plugin_preferences(app_data, &preferences)?;
    plugin_status_inner(app_data, runtime, !safe_mode)
}

fn set_plugin_hot_reload(
    app_data: &Path,
    runtime: &Mutex<aster_plugin::hot_reload::HotReloadController>,
    enabled: bool,
) -> Result<PluginStatus, String> {
    let mut preferences = read_plugin_preferences(app_data)?;
    preferences.hot_reload_enabled = enabled;
    write_plugin_preferences(app_data, &preferences)?;
    plugin_status_inner(app_data, runtime, enabled && !preferences.safe_mode)
}

fn redact_plugin_report(
    root: &Path,
    mut report: aster_plugin::DiscoveryReport,
) -> aster_plugin::DiscoveryReport {
    let root_text = root.to_string_lossy();
    for failure in &mut report.failures {
        failure.manifest = failure
            .manifest
            .strip_prefix(root)
            .unwrap_or_else(|_| Path::new("plugin.toml"))
            .to_path_buf();
        failure.message = failure.message.replace(root_text.as_ref(), "<plugins>");
    }
    report
}

fn plugin_root(app_data: &Path) -> PathBuf {
    app_data.join("plugins")
}

fn plugin_preferences_path(app_data: &Path) -> PathBuf {
    app_data.join("plugin-preferences.json")
}

fn read_plugin_preferences(app_data: &Path) -> Result<PluginPreferences, String> {
    let path = plugin_preferences_path(app_data);
    if !path.exists() {
        return Ok(PluginPreferences::default());
    }
    let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut document: serde_json::Value =
        serde_json::from_str(&source).map_err(|error| error.to_string())?;
    let version = document
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if version > u64::from(CURRENT_PLUGIN_PREFERENCES_VERSION) {
        return Err(format!(
            "plugin preferences v{version} are newer than this build"
        ));
    }
    let migrated = version == 0;
    if migrated {
        let object = document
            .as_object_mut()
            .ok_or_else(|| "plugin preferences must be an object".to_owned())?;
        object.insert(
            "schemaVersion".to_owned(),
            serde_json::Value::from(CURRENT_PLUGIN_PREFERENCES_VERSION),
        );
    }
    let preferences: PluginPreferences =
        serde_json::from_value(document).map_err(|error| error.to_string())?;
    if preferences.schema_version != CURRENT_PLUGIN_PREFERENCES_VERSION {
        return Err("plugin preferences schema version is invalid".to_owned());
    }
    if migrated {
        write_plugin_preferences(app_data, &preferences)?;
    }
    Ok(preferences)
}

fn write_plugin_preferences(
    app_data: &Path,
    preferences: &PluginPreferences,
) -> Result<(), String> {
    let path = plugin_preferences_path(app_data);
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
    app_data: PathBuf,
    async_runtime: tokio::runtime::Runtime,
    hot_reload: Mutex<aster_plugin::hot_reload::HotReloadController>,
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

/// Runs the JSON-lines bridge used exclusively by Electron's main process.
///
/// The renderer never starts this process and receives only the command surface exposed by the
/// context-isolated preload script. Keeping the process alive preserves bounded plugin hot-reload
/// state without introducing native Node modules into the rendering process.
pub fn run() -> Result<(), String> {
    let app_data = app_data_argument()?;
    fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
    let async_runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let mut runtime = BridgeRuntime {
        app_data,
        async_runtime,
        hot_reload: Mutex::new(aster_plugin::hot_reload::HotReloadController::default()),
    };
    tracing::info!(
        event = "bridge_started",
        session_id = std::env::var("ASTER_SESSION_ID").unwrap_or_else(|_| "standalone".to_owned()),
        app_data = %runtime.app_data.display(),
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
                serde_json::to_writer(&mut stdout, &response).map_err(|error| error.to_string())?;
                writeln!(&mut stdout).map_err(|error| error.to_string())?;
                stdout.flush().map_err(|error| error.to_string())?;
                continue;
            }
        };
        let id = request.id;
        let command = request.command.clone();
        let started = Instant::now();
        if !quiet_command(&command) {
            tracing::debug!(
                event = "command_started",
                request_id = id,
                command = %command,
                "desktop command started"
            );
        }
        let response = match dispatch(&mut runtime, request) {
            Ok(result) => {
                if !quiet_command(&command) {
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

fn quiet_command(command: &str) -> bool {
    matches!(command, "poll_plugin_hot_reload" | "save_render_frame")
}

fn app_data_argument() -> Result<PathBuf, String> {
    let mut arguments = std::env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        if argument == "--app-data-dir" {
            return arguments
                .next()
                .map(PathBuf::from)
                .ok_or_else(|| "--app-data-dir requires a path".to_owned());
        }
    }
    Err("Aster desktop bridge requires --app-data-dir".to_owned())
}

fn dispatch(
    runtime: &mut BridgeRuntime,
    request: BridgeRequest,
) -> Result<serde_json::Value, String> {
    let BridgeRequest { command, args, .. } = request;
    match command.as_str() {
        "renderer_capabilities" => serialize(renderer_capabilities()),
        "save_project" => {
            let args: ProjectArgs = parse_args(args)?;
            runtime
                .async_runtime
                .block_on(save_project(args.path, args.project))?;
            Ok(serde_json::Value::Null)
        }
        "load_project" => {
            let args: PathArgs = parse_args(args)?;
            runtime.async_runtime.block_on(load_project(args.path))
        }
        "pack_project" => {
            let args: BundleDestinationArgs = parse_args(args)?;
            runtime
                .async_runtime
                .block_on(pack_project(args.bundle, args.destination))?;
            Ok(serde_json::Value::Null)
        }
        "unpack_project" => {
            let args: ArchiveParentArgs = parse_args(args)?;
            let result = runtime
                .async_runtime
                .block_on(unpack_project(args.archive, args.parent))?;
            serialize(result)
        }
        "link_project_asset" => {
            let args: LinkAssetArgs = parse_args(args)?;
            let result = runtime.async_runtime.block_on(link_project_asset(
                args.bundle,
                args.source,
                args.kind,
            ))?;
            serialize(result)
        }
        "save_autosave" => {
            let args: ProjectArgs = parse_args(args)?;
            runtime
                .async_runtime
                .block_on(save_autosave(args.path, args.project))?;
            Ok(serde_json::Value::Null)
        }
        "recovery_candidate" => {
            let args: PathArgs = parse_args(args)?;
            let result = runtime
                .async_runtime
                .block_on(recovery_candidate(args.path))?;
            serialize(result)
        }
        "clear_autosave" => {
            let args: PathArgs = parse_args(args)?;
            runtime.async_runtime.block_on(clear_autosave(args.path))?;
            Ok(serde_json::Value::Null)
        }
        "save_render_frame" => {
            let args: RenderFrameArgs = parse_args(args)?;
            runtime.async_runtime.block_on(save_render_frame(
                args.directory,
                args.file_name,
                args.data,
            ))?;
            Ok(serde_json::Value::Null)
        }
        "plugin_registry_catalog" => serialize(plugin_registry_catalog()?),
        "plugin_status" => serialize(plugin_status(&runtime.app_data, &runtime.hot_reload)?),
        "load_plugin_runtime" => {
            let args: PluginRuntimeArgs = parse_args(args)?;
            serialize(load_plugin_runtime(
                &runtime.app_data,
                &runtime.hot_reload,
                args.plugin_ids,
            )?)
        }
        "poll_plugin_hot_reload" => serialize(poll_plugin_hot_reload(
            &runtime.app_data,
            &runtime.hot_reload,
        )?),
        "install_plugin" => {
            let args: SourceArgs = parse_args(args)?;
            serialize(install_plugin(
                &runtime.app_data,
                &runtime.hot_reload,
                args.source,
            )?)
        }
        "set_plugin_enabled" => {
            let args: PluginEnabledArgs = parse_args(args)?;
            serialize(set_plugin_enabled(
                &runtime.app_data,
                &runtime.hot_reload,
                args.plugin_id,
                args.enabled,
            )?)
        }
        "set_plugin_safe_mode" => {
            let args: SafeModeArgs = parse_args(args)?;
            serialize(set_plugin_safe_mode(
                &runtime.app_data,
                &runtime.hot_reload,
                args.safe_mode,
            )?)
        }
        "set_plugin_hot_reload" => {
            let args: EnabledArgs = parse_args(args)?;
            serialize(set_plugin_hot_reload(
                &runtime.app_data,
                &runtime.hot_reload,
                args.enabled,
            )?)
        }
        _ => Err(format!("unsupported desktop command `{command}`")),
    }
}

fn parse_args<T: for<'de> Deserialize<'de>>(args: serde_json::Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|error| format!("invalid command arguments: {error}"))
}

fn serialize(value: impl Serialize) -> Result<serde_json::Value, String> {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

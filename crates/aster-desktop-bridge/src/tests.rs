use crate::{plugins::PluginPreferences, project_storage::ProjectStorage};
use serde::Serialize;
use std::fs;

#[test]
fn render_frame_names_cannot_escape_the_selected_directory() {
    assert!(ProjectStorage::valid_render_frame_name("frame_000001.png"));
    assert!(!ProjectStorage::valid_render_frame_name(
        "../frame_000001.png"
    ));
    assert!(!ProjectStorage::valid_render_frame_name("frame_00001x.png"));
    assert!(!ProjectStorage::valid_render_frame_name(
        "frame_一00001.png"
    ));
}

#[test]
fn relative_assets_cannot_escape_the_project_bundle() {
    assert!(ProjectStorage::safe_relative_path("assets/plate.png").is_ok());
    assert!(ProjectStorage::safe_relative_path("../secret.txt").is_err());
    assert!(ProjectStorage::safe_relative_path("C:\\secret.txt").is_err());
    assert!(ProjectStorage::safe_relative_path("/etc/passwd").is_err());
}

#[test]
fn linked_assets_are_copied_inside_the_project_bundle() -> Result<(), Box<dyn std::error::Error>> {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let root = std::env::temp_dir().join(format!("aster-link-test-{suffix}"));
    let bundle = root.join("project");
    fs::create_dir_all(&bundle)?;
    let source = root.join("plate.png");
    fs::write(&source, [1, 2, 3, 4])?;

    let linked = ProjectStorage::link_asset(
        &bundle.to_string_lossy(),
        &source.to_string_lossy(),
        "image",
    )?;
    assert_eq!(linked.relative_path, "assets/plate.png");
    assert_eq!(
        linked.content_identity,
        ProjectStorage::sha256_file_identity(&source)?
    );
    assert_eq!(fs::read(linked.resolved_path)?, [1, 2, 3, 4]);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn rejected_linked_media_leaves_no_published_asset() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-link-rejected-{}", uuid::Uuid::new_v4()));
    let bundle = root.join("project");
    fs::create_dir_all(&bundle)?;
    let source = root.join("invalid.wav");
    fs::write(&source, b"invalid audio")?;
    assert!(
        ProjectStorage::link_asset(
            &bundle.to_string_lossy(),
            &source.to_string_lossy(),
            "audio"
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(bundle.join("assets"))?.count(), 0);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn advanced_media_survives_save_recovery_and_pack_without_its_original()
-> Result<(), Box<dyn std::error::Error>> {
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos();
    let root = std::env::temp_dir().join(format!("aster-media-lifecycle-{suffix}"));
    let bundle = root.join("project");
    let unpack_parent = root.join("unpacked");
    let archive = root.join("packed.aster");
    let original = root.join("original.svg");
    fs::create_dir_all(&unpack_parent)?;
    let bytes = b"<svg viewBox=\"0 0 10 10\"/>";
    fs::write(&original, bytes)?;
    let identity = crate::project_media::fnv64_bytes_identity(bytes);
    let project = serde_json::to_value(LifecycleProject {
        schema_version: 10,
        active_composition_id: "main",
        compositions: [LifecycleComposition {
            id: "main",
            layers: [],
        }],
        media_imports: LifecycleImports {
            version: 1,
            entries: [LifecycleEntry {
                source_id: "svg",
                kind: "svg",
                content_identity: identity.clone(),
                payload_id: "svg:payload",
            }],
            payloads: [LifecyclePayload {
                id: "svg:payload",
                kind: "svg",
                content_identity: identity.clone(),
                width: 10,
                height: 10,
                storage: LifecycleStorage {
                    kind: "external",
                    external_path: original.clone(),
                    byte_identity: identity,
                },
            }],
        },
    })?;

    ProjectStorage::default().save_project(bundle.to_string_lossy().into_owned(), project)?;
    fs::remove_file(&original)?;
    let persisted = fs::read_to_string(bundle.join("project.json"))?;
    assert!(!persisted.contains("externalPath"));
    assert!(!persisted.contains("resolvedPath"));
    assert!(!persisted.contains("\"data\""));

    let loaded = ProjectStorage::default().load_project(bundle.to_string_lossy().into_owned())?;
    assert!(loaded["mediaImports"]["payloads"][0]["storage"]["resolvedPath"].is_string());
    ProjectStorage::default().save_autosave(bundle.to_string_lossy().into_owned(), loaded)?;
    let recovered = ProjectStorage::default()
        .recovery_candidate(bundle.to_string_lossy().into_owned())?
        .ok_or("recovery candidate missing")?;
    assert!(recovered["mediaImports"]["payloads"][0]["storage"]["resolvedPath"].is_string());

    aster_project::ProjectBundle::at(bundle.to_string_lossy().into_owned())
        .pack(archive.to_string_lossy().into_owned())?;
    let unpacked = ProjectStorage::default().unpack_project(
        archive.to_string_lossy().into_owned(),
        unpack_parent.to_string_lossy().into_owned(),
    )?;
    let packed = ProjectStorage::default().load_project(unpacked)?;
    assert!(packed["mediaImports"]["payloads"][0]["storage"]["resolvedPath"].is_string());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn render_frames_are_atomically_written() -> Result<(), Box<dyn std::error::Error>> {
    let directory =
        std::env::temp_dir().join(format!("aster-render-frame-test-{}", std::process::id()));
    fs::create_dir_all(&directory)?;

    ProjectStorage::write_render_frame(
        &directory.to_string_lossy(),
        "frame_000001.png",
        "iVBORw0KGgo=",
    )?;

    assert_eq!(
        fs::read(directory.join("frame_000001.png"))?,
        [137, 80, 78, 71, 13, 10, 26, 10]
    );
    assert!(!directory.join(".frame_000001.png.tmp").exists());
    fs::remove_dir_all(directory)?;
    Ok(())
}

#[test]
fn legacy_plugin_preferences_are_migrated_to_the_versioned_document()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::temp_dir().join(format!(
        "aster-plugin-preferences-test-{}",
        std::process::id()
    ));
    fs::create_dir_all(&directory)?;
    fs::write(
        directory.join("plugin-preferences.json"),
        r#"{"safeMode":true,"disabled":["example.effect"]}"#,
    )?;

    let preferences = PluginPreferences::read(&directory)?;
    assert_eq!(preferences.schema_version, 1);
    assert!(preferences.safe_mode);
    let persisted: serde_json::Value =
        serde_json::from_slice(&fs::read(directory.join("plugin-preferences.json"))?)?;
    assert_eq!(persisted["schemaVersion"], 1);
    fs::remove_dir_all(directory)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleProject {
    schema_version: u32,
    active_composition_id: &'static str,
    compositions: [LifecycleComposition; 1],
    media_imports: LifecycleImports,
}

#[derive(Serialize)]
struct LifecycleComposition {
    id: &'static str,
    layers: [(); 0],
}

#[derive(Serialize)]
struct LifecycleImports {
    version: u32,
    entries: [LifecycleEntry; 1],
    payloads: [LifecyclePayload; 1],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleEntry {
    source_id: &'static str,
    kind: &'static str,
    content_identity: String,
    payload_id: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecyclePayload {
    id: &'static str,
    kind: &'static str,
    content_identity: String,
    width: u32,
    height: u32,
    storage: LifecycleStorage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LifecycleStorage {
    kind: &'static str,
    external_path: std::path::PathBuf,
    byte_identity: String,
}

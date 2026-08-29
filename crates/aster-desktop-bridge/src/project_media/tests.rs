use super::*;
use base64::Engine;
use serde_json::json;
use uuid::Uuid;

fn editor_project() -> Value {
    json!({
        "schemaVersion": 9,
        "activeCompositionId": "main",
        "compositions": [{ "id": "main", "layers": [] }],
    })
}

fn inline_svg(bytes: &[u8]) -> Value {
    let identity = fnv64_bytes_identity(bytes);
    let mut project = editor_project();
    project["mediaImports"] = json!({
        "version": 1,
        "entries": [{
            "sourceId": "svg-source",
            "kind": "svg",
            "contentIdentity": identity,
            "payloadId": format!("svg:{identity}"),
        }],
        "payloads": [{
            "id": format!("svg:{identity}"),
            "kind": "svg",
            "contentIdentity": identity,
            "width": 10,
            "height": 10,
            "storage": {
                "kind": "inline",
                "byteIdentity": identity,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
            }
        }]
    });
    project
}

fn external_svg(bytes: &[u8], path: &Path) -> Value {
    let mut project = inline_svg(bytes);
    project["mediaImports"]["payloads"][0]["storage"] = json!({
        "kind": "external",
        "externalPath": path,
        "byteIdentity": fnv64_bytes_identity(bytes),
    });
    project
}

#[test]
fn materializes_resolves_and_packs_one_deduplicated_payload() {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let unpacked = root.join("unpacked");
    let archive = root.join("project.aster");
    fs::create_dir_all(&root).unwrap();
    let original = root.join("original.svg");
    let bytes = b"<svg width=\"10\" height=\"10\"/>";
    fs::write(&original, bytes).unwrap();
    let mut project = external_svg(bytes, &original);
    materialize_project_media(&bundle, &mut project).unwrap();
    fs::remove_file(&original).unwrap();
    let storage = &project["mediaImports"]["payloads"][0]["storage"];
    assert_eq!(storage["kind"], "relative");
    assert!(storage.get("data").is_none());
    let serialized = serde_json::to_string(&project).unwrap();
    assert!(!serialized.contains("externalPath"));
    assert!(!serialized.contains("resolvedPath"));
    assert!(!serialized.contains(original.to_string_lossy().as_ref()));
    aster_project::save_editor_bundle(&bundle, &project).unwrap();
    aster_project::pack_editor_bundle(&bundle, &archive).unwrap();
    aster_project::unpack_editor_bundle(&archive, &unpacked).unwrap();
    let mut reopened = aster_project::load_editor_bundle(&unpacked).unwrap();
    let paths =
        resolve_project_media_paths(&unpacked.canonicalize().unwrap(), &mut reopened).unwrap();
    assert_eq!(paths.len(), 1);
    assert!(paths[0].is_file());
    assert_eq!(fs::read(&paths[0]).unwrap(), bytes);
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_changed_external_media_and_relative_traversal() {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    fs::create_dir_all(&root).unwrap();
    let original = root.join("original.svg");
    fs::write(&original, b"<svg/>").unwrap();
    let mut changed = external_svg(b"<svg/>", &original);
    fs::write(&original, b"<svg changed='1'/>").unwrap();
    assert!(
        materialize_project_media(&bundle, &mut changed)
            .unwrap_err()
            .contains("identity mismatch")
    );

    let identity = fnv64_bytes_identity(b"outside");
    let mut traversal = inline_svg(b"<svg/>");
    traversal["mediaImports"]["payloads"][0]["storage"] = json!({
        "kind": "relative",
        "relativePath": "../outside.svg",
        "byteIdentity": identity,
    });
    assert!(
        materialize_project_media(&bundle, &mut traversal)
            .unwrap_err()
            .contains("stay inside")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn validates_sequence_selection_metadata_and_loaded_bundle_identity() {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    fs::create_dir_all(&root).unwrap();
    let frame = root.join("plate.0001.png");
    fs::write(&frame, [1, 2, 3]).unwrap();
    let modified = modified_millis(&frame);
    let mut sequence = editor_project();
    sequence["mediaImports"] = json!({
        "version": 1,
        "entries": [{ "sourceId": "sequence", "kind": "imageSequence", "contentIdentity": "metadata", "payloadId": "sequence:metadata" }],
        "payloads": [{
            "id": "sequence:metadata",
            "kind": "imageSequence",
            "contentIdentity": "metadata",
            "frames": [{
                "frame": 1,
                "name": "plate.0001.png",
                "size": 3,
                "lastModified": modified.saturating_sub(1),
                "type": "image/png",
                "storage": { "kind": "external", "externalPath": frame }
            }]
        }]
    });
    assert!(
        materialize_project_media(&bundle, &mut sequence)
            .unwrap_err()
            .contains("modification time changed")
    );

    sequence["mediaImports"]["payloads"][0]["frames"][0]["lastModified"] = Value::from(modified);
    materialize_project_media(&bundle, &mut sequence).unwrap();
    let relative = sequence["mediaImports"]["payloads"][0]["frames"][0]["storage"]["relativePath"]
        .as_str()
        .unwrap();
    fs::write(bundle.join(relative), [3, 2, 1]).unwrap();
    assert!(
        resolve_project_media_paths(&bundle.canonicalize().unwrap(), &mut sequence)
            .unwrap_err()
            .contains("identity mismatch")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_linked_bundle_sources_and_managed_destinations() {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let outside = root.join("outside.svg");
    fs::create_dir_all(bundle.join("assets/imports")).unwrap();
    fs::write(&outside, b"<svg/>").unwrap();
    let identity = fnv64_bytes_identity(b"<svg/>");
    let relative = import_relative_path(&identity, ".svg");
    let destination = bundle.join(&relative);
    if !create_file_symlink(&outside, &destination) {
        let _ = fs::remove_dir_all(root);
        return;
    }

    let mut relative_project = inline_svg(b"<svg/>");
    relative_project["mediaImports"]["payloads"][0]["storage"] = json!({
        "kind": "relative",
        "relativePath": slash_path(&relative),
        "byteIdentity": identity,
    });
    assert!(
        materialize_project_media(&bundle, &mut relative_project)
            .unwrap_err()
            .contains("link or reparse point")
    );

    let mut inline_project = inline_svg(b"<svg/>");
    assert!(
        materialize_project_media(&bundle, &mut inline_project)
            .unwrap_err()
            .contains("link or reparse point")
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn shares_one_psd_payload_and_preserves_unreferenced_managed_assets() {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let bytes = b"shared compressed PSD";
    let identity = fnv64_bytes_identity(bytes);
    let stale = bundle.join("assets/imports/unreferenced.psd");
    fs::create_dir_all(stale.parent().unwrap()).unwrap();
    fs::write(&stale, b"still owned by another snapshot").unwrap();
    let mut project = editor_project();
    project["mediaImports"] = json!({
        "version": 1,
        "entries": [
            { "sourceId": "layer-a", "kind": "psd", "contentIdentity": format!("{identity}:composition:a"), "payloadId": "psd:shared", "documentIdentity": identity, "importMode": "composition", "layerKey": "a" },
            { "sourceId": "layer-b", "kind": "psd", "contentIdentity": format!("{identity}:composition:b"), "payloadId": "psd:shared", "documentIdentity": identity, "importMode": "composition", "layerKey": "b" }
        ],
        "payloads": [{
            "id": "psd:shared",
            "kind": "psd",
            "documentIdentity": identity,
            "storage": { "kind": "inline", "byteIdentity": identity, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }
        }]
    });
    materialize_project_media(&bundle, &mut project).unwrap();
    let files = fs::read_dir(bundle.join("assets/imports"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 2);
    assert!(stale.is_file());
    assert_eq!(
        project["mediaImports"]["payloads"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let _ = fs::remove_dir_all(root);
}

#[test]
fn rejects_identity_mismatch_oversize_and_missing_relative_media() {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let mut mismatch = inline_svg(b"<svg/>");
    mismatch["mediaImports"]["payloads"][0]["contentIdentity"] =
        Value::String("fnv64:0000000000000000:6".to_owned());
    assert!(
        materialize_project_media(&bundle, &mut mismatch)
            .unwrap_err()
            .contains("identity mismatch")
    );

    let mut oversize = inline_svg(b"<svg/>");
    oversize["mediaImports"]["payloads"][0]["storage"]["byteIdentity"] =
        Value::String(format!("fnv64:0000000000000000:{}", MAX_PORTABLE_BYTES + 1));
    assert!(
        materialize_project_media(&bundle, &mut oversize)
            .unwrap_err()
            .contains("size limit")
    );

    let identity = fnv64_bytes_identity(b"missing");
    let mut missing = inline_svg(b"<svg/>");
    missing["mediaImports"]["payloads"][0]["storage"] = json!({
        "kind": "relative",
        "relativePath": "assets/imports/missing.svg",
        "byteIdentity": identity,
    });
    fs::create_dir_all(&bundle).unwrap();
    let canonical = bundle.canonicalize().unwrap();
    assert!(
        resolve_project_media_paths(&canonical, &mut missing)
            .unwrap_err()
            .contains("missing from the project bundle")
    );
    let _ = fs::remove_dir_all(root);
}

#[cfg(windows)]
fn create_file_symlink(source: &Path, destination: &Path) -> bool {
    std::os::windows::fs::symlink_file(source, destination).is_ok()
}

#[cfg(unix)]
fn create_file_symlink(source: &Path, destination: &Path) -> bool {
    std::os::unix::fs::symlink(source, destination).is_ok()
}

fn modified_millis(path: &Path) -> u64 {
    fs::metadata(path)
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
        .try_into()
        .unwrap()
}

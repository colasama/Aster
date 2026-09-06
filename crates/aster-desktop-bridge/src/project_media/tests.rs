use super::fixtures::{EntryFixture, FrameFixture, MediaFixture, PayloadFixture, StorageFixture};
use super::*;
use base64::Engine;
use uuid::Uuid;

#[test]
fn configured_media_limits_count_entries_and_deduplicate_bytes()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-media-budget-{}", Uuid::new_v4()));
    let mut project = MediaFixture::inline_svg(b"<svg/>")?;
    let duplicate = project["mediaImports"]["payloads"][0].clone();
    project["mediaImports"]["payloads"]
        .as_array_mut()
        .ok_or("payload array missing")?
        .push(duplicate);
    let mut media = ProjectMedia {
        limits: MediaLimits {
            max_media_files: 2,
            max_bundle_media_bytes: 6,
            ..Default::default()
        },
    };
    media.process(&root, &mut project, MediaOperation::Materialize)?;
    assert_eq!(fs::read_dir(root.join("assets/imports"))?.count(), 1);
    media.limits.max_media_files = 1;
    assert!(
        media
            .process(&root, &mut project, MediaOperation::Resolve)
            .is_err()
    );
    media.limits.max_media_files = 2;
    media.limits.max_bundle_media_bytes = 5;
    assert!(
        media
            .process(&root, &mut project, MediaOperation::Resolve)
            .is_err()
    );
    media.limits.max_bundle_media_bytes = 6;
    media.limits.max_payloads = 1;
    assert!(
        media
            .process(&root, &mut project, MediaOperation::Resolve)
            .is_err()
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn materializes_and_resolves_content_addressed_video_footage()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-project-footage-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let bytes = b"bounded video fixture";
    let mut project = MediaFixture::inline_footage(bytes, "video", ".mp4")?;

    ProjectMedia::default().process(&bundle, &mut project, MediaOperation::Materialize)?;
    let storage = &project["mediaImports"]["payloads"][0]["storage"];
    assert_eq!(storage["kind"], "relative");
    assert!(storage["data"].is_null());
    let relative = storage["relativePath"]
        .as_str()
        .ok_or("missing fixture field")?;
    assert!(relative.starts_with("assets/imports/"));
    assert!(relative.ends_with(".mp4"));
    assert_eq!(fs::read(bundle.join(relative))?, bytes);

    let canonical = bundle.canonicalize()?;
    let resolved =
        ProjectMedia::default().process(&canonical, &mut project, MediaOperation::Resolve)?;
    assert_eq!(resolved.len(), 1);
    assert_eq!(fs::read(&resolved[0])?, bytes);

    let external = root.join("changed.mp4");
    fs::write(&external, b"changed after import")?;
    let mut changed = MediaFixture::inline_footage(bytes, "video", ".mp4")?;
    changed["mediaImports"]["payloads"][0]["storage"] =
        serde_json::to_value(StorageFixture::External {
            external_path: external,
            byte_identity: None,
        })?;
    assert!(
        ProjectMedia::default()
            .process(
                &root.join("changed-bundle"),
                &mut changed,
                MediaOperation::Materialize
            )
            .err()
            .ok_or("expected rejection")?
            .contains("identity mismatch")
    );
    let _ = fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn materializes_resolves_and_packs_one_deduplicated_payload()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let unpacked = root.join("unpacked");
    let archive = root.join("project.aster");
    fs::create_dir_all(&root)?;
    let original = root.join("original.svg");
    let bytes = b"<svg width=\"10\" height=\"10\"/>";
    fs::write(&original, bytes)?;
    let mut project = MediaFixture::external_svg(bytes, &original)?;
    ProjectMedia::default().process(&bundle, &mut project, MediaOperation::Materialize)?;
    fs::remove_file(&original)?;
    let storage = &project["mediaImports"]["payloads"][0]["storage"];
    assert_eq!(storage["kind"], "relative");
    assert!(storage.get("data").is_none());
    let serialized = serde_json::to_string(&project)?;
    assert!(!serialized.contains("externalPath"));
    assert!(!serialized.contains("resolvedPath"));
    assert!(!serialized.contains(original.to_string_lossy().as_ref()));
    aster_project::ProjectBundle::at(&bundle).save_editor(&project)?;
    aster_project::ProjectBundle::at(&bundle).pack(&archive)?;
    aster_project::ProjectBundle::at(&unpacked).unpack(&archive)?;
    let mut reopened = aster_project::ProjectBundle::at(&unpacked).load_editor()?;
    let paths = ProjectMedia::default().process(
        &unpacked.canonicalize()?,
        &mut reopened,
        MediaOperation::Resolve,
    )?;
    assert_eq!(paths.len(), 1);
    assert!(paths[0].is_file());
    assert_eq!(fs::read(&paths[0])?, bytes);
    let _ = fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn rejects_changed_external_media_and_relative_traversal() -> Result<(), Box<dyn std::error::Error>>
{
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    fs::create_dir_all(&root)?;
    let original = root.join("original.svg");
    fs::write(&original, b"<svg/>")?;
    let mut changed = MediaFixture::external_svg(b"<svg/>", &original)?;
    fs::write(&original, b"<svg changed='1'/>")?;
    assert!(
        ProjectMedia::default()
            .process(&bundle, &mut changed, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("identity mismatch")
    );

    let identity = Fnv64State::bytes_identity(b"outside");
    let mut traversal = MediaFixture::inline_svg(b"<svg/>")?;
    traversal["mediaImports"]["payloads"][0]["storage"] =
        serde_json::to_value(StorageFixture::Relative {
            relative_path: ("../outside.svg").into(),
            byte_identity: identity,
        })?;
    assert!(
        ProjectMedia::default()
            .process(&bundle, &mut traversal, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("stay inside")
    );
    let _ = fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn validates_sequence_selection_metadata_and_loaded_bundle_identity()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    fs::create_dir_all(&root)?;
    let frame = root.join("plate.0001.png");
    fs::write(&frame, [1, 2, 3])?;
    let modified: u64 = fs::metadata(&frame)?
        .modified()?
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .try_into()?;
    let mut sequence = MediaFixture::document(
        PayloadFixture {
            id: "sequence:metadata".into(),
            kind: "imageSequence".into(),
            content_identity: Some("metadata".into()),
            frames: Some(vec![FrameFixture {
                frame: 1,
                name: "plate.0001.png".into(),
                size: 3,
                last_modified: modified.saturating_sub(1),
                media_type: "image/png".into(),
                storage: StorageFixture::External {
                    external_path: frame.clone(),
                    byte_identity: None,
                },
            }]),
            ..Default::default()
        },
        vec![EntryFixture {
            source_id: "sequence".into(),
            kind: "imageSequence".into(),
            content_identity: "metadata".into(),
            payload_id: "sequence:metadata".into(),
            ..Default::default()
        }],
    )?;
    assert!(
        ProjectMedia::default()
            .process(&bundle, &mut sequence, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("modification time changed")
    );

    sequence["mediaImports"]["payloads"][0]["frames"][0]["lastModified"] = Value::from(modified);
    ProjectMedia::default().process(&bundle, &mut sequence, MediaOperation::Materialize)?;
    let relative = sequence["mediaImports"]["payloads"][0]["frames"][0]["storage"]["relativePath"]
        .as_str()
        .ok_or("missing fixture field")?;
    fs::write(bundle.join(relative), [3, 2, 1])?;
    assert!(
        ProjectMedia::default()
            .process(
                &bundle.canonicalize()?,
                &mut sequence,
                MediaOperation::Resolve
            )
            .err()
            .ok_or("expected rejection")?
            .contains("identity mismatch")
    );
    let _ = fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn rejects_linked_bundle_sources_and_managed_destinations() -> Result<(), Box<dyn std::error::Error>>
{
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let outside = root.join("outside.svg");
    fs::create_dir_all(bundle.join("assets/imports"))?;
    fs::write(&outside, b"<svg/>")?;
    let identity = Fnv64State::bytes_identity(b"<svg/>");
    let relative = MediaFiles::import_relative_path(&identity, ".svg");
    let destination = bundle.join(&relative);
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&outside, &destination);
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&outside, &destination);
    if linked.is_err() {
        let _ = fs::remove_dir_all(root);
        return Ok(());
    }

    let mut relative_project = MediaFixture::inline_svg(b"<svg/>")?;
    relative_project["mediaImports"]["payloads"][0]["storage"] =
        serde_json::to_value(StorageFixture::Relative {
            relative_path: MediaFiles::slash_path(&relative),
            byte_identity: identity,
        })?;
    assert!(
        ProjectMedia::default()
            .process(&bundle, &mut relative_project, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("link or reparse point")
    );

    let mut inline_project = MediaFixture::inline_svg(b"<svg/>")?;
    assert!(
        ProjectMedia::default()
            .process(&bundle, &mut inline_project, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("link or reparse point")
    );
    let _ = fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn shares_one_psd_payload_and_preserves_unreferenced_managed_assets()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let bytes = b"shared compressed PSD";
    let identity = Fnv64State::bytes_identity(bytes);
    let stale = bundle.join("assets/imports/unreferenced.psd");
    fs::create_dir_all(stale.parent().ok_or("missing fixture field")?)?;
    fs::write(&stale, b"still owned by another snapshot")?;
    let mut project = MediaFixture::document(
        PayloadFixture {
            id: "psd:shared".into(),
            kind: "psd".into(),
            document_identity: Some(identity.clone()),
            storage: Some(StorageFixture::Inline {
                byte_identity: identity.clone(),
                data: base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
            ..Default::default()
        },
        ["a", "b"]
            .into_iter()
            .map(|key| EntryFixture {
                source_id: format!("layer-{key}"),
                kind: "psd".into(),
                content_identity: format!("{identity}:composition:{key}"),
                payload_id: "psd:shared".into(),
                document_identity: Some(identity.clone()),
                import_mode: Some("composition".into()),
                layer_key: Some(key.into()),
            })
            .collect(),
    )?;
    ProjectMedia::default().process(&bundle, &mut project, MediaOperation::Materialize)?;
    let files = fs::read_dir(bundle.join("assets/imports"))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()?;
    assert_eq!(files.len(), 2);
    assert!(stale.is_file());
    assert_eq!(
        project["mediaImports"]["payloads"]
            .as_array()
            .ok_or("missing fixture field")?
            .len(),
        1
    );
    let _ = fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn rejects_identity_mismatch_oversize_and_missing_relative_media()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-project-media-{}", Uuid::new_v4()));
    let bundle = root.join("bundle");
    let mut mismatch = MediaFixture::inline_svg(b"<svg/>")?;
    mismatch["mediaImports"]["payloads"][0]["contentIdentity"] =
        Value::String("fnv64:0000000000000000:6".to_owned());
    assert!(
        ProjectMedia::default()
            .process(&bundle, &mut mismatch, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("identity mismatch")
    );

    let mut oversize = MediaFixture::inline_svg(b"<svg/>")?;
    oversize["mediaImports"]["payloads"][0]["storage"]["byteIdentity"] = Value::String(format!(
        "fnv64:0000000000000000:{}",
        MediaLimits::default().max_portable_bytes + 1
    ));
    assert!(
        ProjectMedia::default()
            .process(&bundle, &mut oversize, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("size limit")
    );

    let identity = Fnv64State::bytes_identity(b"missing");
    let mut missing = MediaFixture::inline_svg(b"<svg/>")?;
    missing["mediaImports"]["payloads"][0]["storage"] =
        serde_json::to_value(StorageFixture::Relative {
            relative_path: ("assets/imports/missing.svg").into(),
            byte_identity: identity,
        })?;
    fs::create_dir_all(&bundle)?;
    let canonical = bundle.canonicalize()?;
    assert!(
        ProjectMedia::default()
            .process(&canonical, &mut missing, MediaOperation::Resolve)
            .err()
            .ok_or("expected rejection")?
            .contains("missing from the project bundle")
    );
    let _ = fs::remove_dir_all(root);
    Ok(())
}

#[test]
fn inline_media_uses_payload_limits_instead_of_metadata_string_limits()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-large-inline-{}", Uuid::new_v4()));
    let bytes = format!("<svg><!--{}--></svg>", "x".repeat(48 * 1024)).into_bytes();
    let mut project = MediaFixture::inline_svg(&bytes)?;
    ProjectMedia::default().process(&root, &mut project, MediaOperation::Materialize)?;
    let relative = project["mediaImports"]["payloads"][0]["storage"]["relativePath"]
        .as_str()
        .ok_or("missing fixture field")?;
    assert_eq!(fs::read(root.join(relative))?, bytes);
    let mut oversized = MediaFixture::inline_svg(b"small")?;
    oversized["mediaImports"]["payloads"][0]["storage"]["data"] = Value::String("A".repeat(80_000));
    assert!(
        ProjectMedia::default()
            .process(&root, &mut oversized, MediaOperation::Materialize)
            .err()
            .ok_or("expected rejection")?
            .contains("length does not match")
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

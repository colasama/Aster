use aster_core::Composition;
use aster_timeline::{FrameRate, Time};

use super::*;

impl EditorFixture {
    fn core() -> Result<Project, Box<dyn std::error::Error>> {
        let composition = Composition {
            id: Uuid::new_v4(),
            name: "Main".into(),
            width: 3840,
            height: 2160,
            frame_rate: FrameRate::default(),
            duration: Time::new(5, 1)?,
            background: [0.0, 0.0, 0.0, 1.0],
            layers: Vec::new(),
        };
        Ok(Project {
            schema_version: Project::SCHEMA_VERSION,
            id: Uuid::new_v4(),
            name: "Roundtrip".into(),
            active_composition: composition.id,
            compositions: vec![composition],
        })
    }
}

#[test]
fn project_bundle_roundtrips() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::temp_dir().join(format!("aster-test-{}", Uuid::new_v4()));
    let expected = EditorFixture::core()?;
    ProjectBundle::at(&directory).save_core(&expected)?;
    assert_eq!(ProjectBundle::at(&directory).load_core()?, expected);
    fs::remove_dir_all(directory)?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorFixture {
    schema_version: u64,
    id: Uuid,
    name: String,
    active_composition_id: String,
    compositions: Vec<EditorComposition>,
    updated_at: String,
    command_log: Vec<Value>,
    presentation_only: EditorPresentation,
}

#[derive(serde::Serialize)]
struct EditorComposition {
    id: String,
    layers: Vec<Value>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorPresentation {
    expanded_layers: Vec<String>,
}

impl EditorFixture {
    fn document() -> Result<Value, serde_json::Error> {
        serde_json::to_value(Self {
            schema_version: 10,
            id: Uuid::new_v4(),
            name: "Editor roundtrip".into(),
            active_composition_id: "main".into(),
            compositions: vec![EditorComposition {
                id: "main".into(),
                layers: Vec::new(),
            }],
            updated_at: "2026-08-20T00:00:00.000Z".into(),
            command_log: Vec::new(),
            presentation_only: EditorPresentation {
                expanded_layers: vec!["hero".into()],
            },
        })
    }
}

#[test]
fn editor_bundle_is_lossless() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::temp_dir().join(format!("aster-editor-{}", Uuid::new_v4()));
    let expected = EditorFixture::document()?;
    ProjectBundle::at(&directory).save_editor(&expected)?;
    assert_eq!(ProjectBundle::at(&directory).load_editor()?, expected);
    fs::remove_dir_all(directory)?;
    Ok(())
}

#[test]
fn editor_bundle_reads_legacy_versions_but_writes_only_current()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::temp_dir().join(format!("aster-editor-legacy-{}", Uuid::new_v4()));
    fs::create_dir_all(&directory)?;
    let bundle = ProjectBundle::at(&directory);
    for version in 1..10_u32 {
        let mut previous = EditorFixture::document()?;
        previous["schemaVersion"] = Value::from(version);
        fs::write(
            directory.join(ProjectBundle::PROJECT_FILE),
            serde_json::to_vec_pretty(&previous)?,
        )?;
        assert_eq!(bundle.load_editor()?, previous);
        assert!(matches!(bundle.save_editor(&previous),
            Err(ProjectError::UnsupportedSchema { found, supported: 10 }) if found == version));
    }
    fs::remove_dir_all(directory)?;
    Ok(())
}

#[test]
fn autosave_is_offered_for_recovery() -> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::temp_dir().join(format!("aster-recovery-{}", Uuid::new_v4()));
    let expected = EditorFixture::document()?;
    ProjectBundle::at(&directory).save_autosave(&expected)?;
    assert_eq!(
        ProjectBundle::at(&directory).recovery_candidate()?,
        Some(expected)
    );
    ProjectBundle::at(&directory).clear_autosave()?;
    assert_eq!(ProjectBundle::at(&directory).recovery_candidate()?, None);
    fs::remove_dir_all(directory)?;
    Ok(())
}

#[test]
fn editor_validation_rejects_unknown_active_composition() -> Result<(), Box<dyn std::error::Error>>
{
    let mut invalid = EditorFixture::document()?;
    invalid["activeCompositionId"] = Value::String("missing".into());
    assert!(matches!(
        ProjectBundle::validate_editor(&invalid, false),
        Err(ProjectError::MissingActiveComposition)
    ));
    Ok(())
}

#[test]
fn packed_editor_bundle_roundtrips_project_and_assets() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-packed-test-{}", Uuid::new_v4()));
    let source = root.join("source");
    let destination = root.join("unpacked");
    let archive = root.join("project.aster");
    let expected = EditorFixture::document()?;
    fs::create_dir_all(source.join("assets/nested"))?;
    ProjectBundle::at(&source).save_editor(&expected)?;
    fs::write(source.join("assets/nested/texture.bin"), b"gpu asset")?;

    ProjectBundle::at(&source).pack(&archive)?;
    ProjectBundle::at(&destination).unpack(&archive)?;

    assert_eq!(ProjectBundle::at(&destination).load_editor()?, expected);
    assert_eq!(
        fs::read(destination.join("assets/nested/texture.bin"))?,
        b"gpu asset"
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn packed_editor_bundle_rejects_path_traversal() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-packed-unsafe-{}", Uuid::new_v4()));
    fs::create_dir_all(&root)?;
    let archive_path = root.join("unsafe.aster");
    let mut archive = ZipWriter::new(File::create(&archive_path)?);
    archive.start_file("../escape.txt", SimpleFileOptions::default())?;
    archive.write_all(b"escape")?;
    archive.finish()?;

    assert!(matches!(
        ProjectBundle::at(root.join("unpacked")).unpack(&archive_path),
        Err(ProjectError::UnsafePackedPath(_))
    ));
    assert!(!root.join("escape.txt").exists());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn interrupted_directory_publication_recovers_the_previous_bundle()
-> Result<(), Box<dyn std::error::Error>> {
    let root = std::env::temp_dir().join(format!("aster-recover-swap-{}", Uuid::new_v4()));
    let directory = root.join("project");
    let backup = root.join("project.aster-backup");
    let bundle = ProjectBundle::at(&directory);
    let document = EditorFixture::document()?;
    bundle.save_editor(&document)?;
    fs::rename(&directory, &backup)?;
    assert_eq!(bundle.load_editor()?, document);
    assert!(!backup.exists());
    fs::rename(&directory, &backup)?;
    assert_eq!(bundle.prepare_directory()?, directory.canonicalize()?);
    assert_eq!(bundle.load_editor()?, document);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn failed_archive_publication_preserves_existing_outputs() -> Result<(), Box<dyn std::error::Error>>
{
    let root = std::env::temp_dir().join(format!("aster-pack-limits-{}", Uuid::new_v4()));
    let mut source = ProjectBundle::at(root.join("source"));
    source.save_editor(&EditorFixture::document()?)?;
    let archive = root.join("project.aster");
    fs::write(&archive, b"existing archive")?;
    source.limits.max_packed_bytes = 1;
    assert!(matches!(
        source.pack(&archive),
        Err(ProjectError::PackedSizeLimit)
    ));
    assert_eq!(fs::read(&archive)?, b"existing archive");
    source.limits = BundleLimits::default();
    source.pack(&archive)?;
    let destination = ProjectBundle::at(root.join("destination"));
    destination.save_editor(&EditorFixture::document()?)?;
    destination.unpack(&archive)?;
    assert_eq!(source.load_editor()?, destination.load_editor()?);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn editor_validation_rejects_legacy_schema() -> Result<(), Box<dyn std::error::Error>> {
    let mut legacy = EditorFixture::document()?;
    legacy["schemaVersion"] = Value::from(0);
    assert!(matches!(
        ProjectBundle::validate_editor(&legacy, false),
        Err(ProjectError::UnsupportedSchema { found: 0, .. })
    ));
    Ok(())
}

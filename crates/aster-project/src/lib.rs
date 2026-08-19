//! Git-friendly project bundle persistence.

use std::{
    fs::{self, File},
    io::{BufReader, BufWriter, Write},
    path::{Path, PathBuf},
};

use aster_core::Project;
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

pub const PROJECT_FILE: &str = "project.json";
pub const AUTOSAVE_FILE: &str = "project.autosave.json";
pub const EDITOR_SCHEMA_VERSION: u64 = 0;

pub fn save_bundle(bundle: impl AsRef<Path>, project: &Project) -> Result<(), ProjectError> {
    let bundle = bundle.as_ref();
    fs::create_dir_all(bundle)?;
    let destination = bundle.join(PROJECT_FILE);
    let temporary = bundle.join(format!(".{PROJECT_FILE}.{}.tmp", Uuid::new_v4()));
    {
        let file = File::create(&temporary)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, project)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
    }
    replace_file(&temporary, &destination)?;
    Ok(())
}

pub fn load_bundle(bundle: impl AsRef<Path>) -> Result<Project, ProjectError> {
    let path = bundle.as_ref().join(PROJECT_FILE);
    let project: Project = serde_json::from_reader(BufReader::new(File::open(path)?))?;
    validate(&project)?;
    Ok(project)
}

/// Saves the lossless editor document used by the TypeScript workspace.
///
/// The editor and compute-core models deliberately have different shapes: the
/// editor retains presentation details while `aster_core::Project` is optimized
/// for execution. Keeping this boundary explicit prevents lossy native saves.
pub fn save_editor_bundle(bundle: impl AsRef<Path>, project: &Value) -> Result<(), ProjectError> {
    validate_editor_project(project)?;
    write_json_atomic(bundle.as_ref(), PROJECT_FILE, project)
}

pub fn load_editor_bundle(bundle: impl AsRef<Path>) -> Result<Value, ProjectError> {
    let project: Value = serde_json::from_reader(BufReader::new(File::open(
        bundle.as_ref().join(PROJECT_FILE),
    )?))?;
    validate_editor_project(&project)?;
    Ok(project)
}

pub fn save_autosave(bundle: impl AsRef<Path>, project: &Value) -> Result<(), ProjectError> {
    validate_editor_project(project)?;
    write_json_atomic(bundle.as_ref(), AUTOSAVE_FILE, project)
}

/// Returns an autosave only when it is newer than the primary project file.
pub fn recovery_candidate(bundle: impl AsRef<Path>) -> Result<Option<Value>, ProjectError> {
    let bundle = bundle.as_ref();
    let autosave_path = bundle.join(AUTOSAVE_FILE);
    if !autosave_path.exists() {
        return Ok(None);
    }
    let project_path = bundle.join(PROJECT_FILE);
    if project_path.exists()
        && fs::metadata(&autosave_path)?.modified()? <= fs::metadata(project_path)?.modified()?
    {
        return Ok(None);
    }
    let project = serde_json::from_reader(BufReader::new(File::open(autosave_path)?))?;
    validate_editor_project(&project)?;
    Ok(Some(project))
}

pub fn clear_autosave(bundle: impl AsRef<Path>) -> Result<(), ProjectError> {
    let path = bundle.as_ref().join(AUTOSAVE_FILE);
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

pub fn validate_editor_project(project: &Value) -> Result<(), ProjectError> {
    let object = project
        .as_object()
        .ok_or(ProjectError::InvalidEditorDocument(
            "project root must be an object",
        ))?;
    let version = object.get("schemaVersion").and_then(Value::as_u64).ok_or(
        ProjectError::InvalidEditorDocument("schemaVersion must be an unsigned integer"),
    )?;
    if version > EDITOR_SCHEMA_VERSION {
        return Err(ProjectError::UnsupportedSchema {
            found: u32::try_from(version).unwrap_or(u32::MAX),
            supported: EDITOR_SCHEMA_VERSION as u32,
        });
    }
    let compositions = object
        .get("compositions")
        .and_then(Value::as_array)
        .filter(|compositions| !compositions.is_empty())
        .ok_or(ProjectError::NoCompositions)?;
    let active = object
        .get("activeCompositionId")
        .and_then(Value::as_str)
        .ok_or(ProjectError::InvalidEditorDocument(
            "activeCompositionId must be a string",
        ))?;
    if !compositions
        .iter()
        .any(|composition| composition.get("id").and_then(Value::as_str) == Some(active))
    {
        return Err(ProjectError::MissingActiveComposition);
    }
    Ok(())
}

pub fn validate(project: &Project) -> Result<(), ProjectError> {
    if project.schema_version > Project::SCHEMA_VERSION {
        return Err(ProjectError::UnsupportedSchema {
            found: project.schema_version,
            supported: Project::SCHEMA_VERSION,
        });
    }
    if project.compositions.is_empty() {
        return Err(ProjectError::NoCompositions);
    }
    if project.composition(project.active_composition).is_none() {
        return Err(ProjectError::MissingActiveComposition);
    }
    Ok(())
}

fn replace_file(temporary: &Path, destination: &Path) -> Result<(), std::io::Error> {
    if !destination.exists() {
        return fs::rename(temporary, destination);
    }
    let backup = backup_path(destination);
    fs::rename(destination, &backup)?;
    match fs::rename(temporary, destination) {
        Ok(()) => {
            fs::remove_file(backup)?;
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(backup, destination);
            Err(error)
        }
    }
}

fn write_json_atomic(
    bundle: &Path,
    file_name: &str,
    value: &impl serde::Serialize,
) -> Result<(), ProjectError> {
    fs::create_dir_all(bundle)?;
    let destination = bundle.join(file_name);
    let temporary = bundle.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    {
        let file = File::create(&temporary)?;
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, value)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
    }
    replace_file(&temporary, &destination)?;
    Ok(())
}

fn backup_path(destination: &Path) -> PathBuf {
    destination.with_extension("json.backup")
}

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("project I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("project JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("project schema {found} is newer than supported schema {supported}")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("project contains no compositions")]
    NoCompositions,
    #[error("active composition is missing")]
    MissingActiveComposition,
    #[error("editor project is invalid: {0}")]
    InvalidEditorDocument(&'static str),
}

#[cfg(test)]
mod tests {
    use aster_core::Composition;
    use aster_timeline::{FrameRate, Time};

    use super::*;

    fn project() -> Project {
        let composition = Composition {
            id: Uuid::new_v4(),
            name: "Main".into(),
            width: 3840,
            height: 2160,
            frame_rate: FrameRate::default(),
            duration: Time::new(5, 1).unwrap(),
            background: [0.0, 0.0, 0.0, 1.0],
            layers: Vec::new(),
        };
        Project {
            schema_version: Project::SCHEMA_VERSION,
            id: Uuid::new_v4(),
            name: "Roundtrip".into(),
            active_composition: composition.id,
            compositions: vec![composition],
        }
    }

    #[test]
    fn project_bundle_roundtrips() {
        let directory = std::env::temp_dir().join(format!("aster-test-{}", Uuid::new_v4()));
        let expected = project();
        save_bundle(&directory, &expected).unwrap();
        assert_eq!(load_bundle(&directory).unwrap(), expected);
        fs::remove_dir_all(directory).unwrap();
    }

    fn editor_project() -> Value {
        serde_json::json!({
            "schemaVersion": 0,
            "id": Uuid::new_v4().to_string(),
            "name": "Editor roundtrip",
            "activeCompositionId": "main",
            "compositions": [{ "id": "main", "layers": [] }],
            "updatedAt": "2026-08-20T00:00:00.000Z",
            "presentationOnly": { "expandedLayers": ["hero"] }
        })
    }

    #[test]
    fn editor_bundle_is_lossless() {
        let directory = std::env::temp_dir().join(format!("aster-editor-{}", Uuid::new_v4()));
        let expected = editor_project();
        save_editor_bundle(&directory, &expected).unwrap();
        assert_eq!(load_editor_bundle(&directory).unwrap(), expected);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn autosave_is_offered_for_recovery() {
        let directory = std::env::temp_dir().join(format!("aster-recovery-{}", Uuid::new_v4()));
        let expected = editor_project();
        save_autosave(&directory, &expected).unwrap();
        assert_eq!(recovery_candidate(&directory).unwrap(), Some(expected));
        clear_autosave(&directory).unwrap();
        assert_eq!(recovery_candidate(&directory).unwrap(), None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn editor_validation_rejects_unknown_active_composition() {
        let mut invalid = editor_project();
        invalid["activeCompositionId"] = Value::String("missing".into());
        assert!(matches!(
            validate_editor_project(&invalid),
            Err(ProjectError::MissingActiveComposition)
        ));
    }
}

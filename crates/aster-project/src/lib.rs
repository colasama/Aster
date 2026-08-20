//! Git-friendly project bundle persistence.

mod disk_cache;
mod proxy;

pub use disk_cache::{DiskCache, DiskCacheBenchmark, DiskCacheStatistics};
pub use proxy::{
    CancellationToken, ProxyError, ProxyGenerationPlan, ProxyMetadata, ProxyProfile, ProxyValidity,
    finalize_proxy_generation, inspect_proxy, prepare_proxy_generation, write_proxy_metadata,
};

use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    path::{Component, Path, PathBuf},
};

use aster_core::Project;
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub const PROJECT_FILE: &str = "project.json";
pub const AUTOSAVE_FILE: &str = "project.autosave.json";
pub const EDITOR_SCHEMA_VERSION: u64 = 1;
const MAX_PACKED_ENTRIES: usize = 4_096;
const MAX_PACKED_BYTES: u64 = 2 * 1024 * 1024 * 1024;

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

pub fn pack_editor_bundle(
    bundle: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<(), ProjectError> {
    let bundle = bundle.as_ref().canonicalize()?;
    let project = load_editor_bundle(&bundle)?;
    let destination = destination.as_ref();
    let temporary = destination.with_extension(format!("aster.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let file = File::create(&temporary)?;
        let mut archive = ZipWriter::new(BufWriter::new(file));
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o644);
        archive.start_file(PROJECT_FILE, options)?;
        serde_json::to_writer_pretty(&mut archive, &project)?;
        archive.write_all(b"\n")?;
        let assets = bundle.join("assets");
        let mut files = packed_asset_files(&assets)?;
        files.sort();
        if files.len() + 1 > MAX_PACKED_ENTRIES {
            return Err(ProjectError::PackedEntryLimit);
        }
        let mut total_bytes = 0_u64;
        for source in files {
            let metadata = fs::symlink_metadata(&source)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(ProjectError::UnsafePackedPath(source));
            }
            total_bytes = total_bytes.saturating_add(metadata.len());
            if total_bytes > MAX_PACKED_BYTES {
                return Err(ProjectError::PackedSizeLimit);
            }
            let relative = source
                .strip_prefix(&bundle)
                .map_err(|_| ProjectError::UnsafePackedPath(source.clone()))?;
            let name = archive_path(relative)?;
            archive.start_file(name, options)?;
            io::copy(&mut BufReader::new(File::open(source)?), &mut archive)?;
        }
        let writer = archive.finish()?;
        writer
            .into_inner()
            .map_err(std::io::IntoInnerError::into_error)?
            .sync_all()?;
        replace_file(&temporary, destination)?;
        Ok(())
    })();
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn unpack_editor_bundle(
    archive_path: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> Result<(), ProjectError> {
    let archive_path = archive_path.as_ref();
    let destination = destination.as_ref();
    let parent = destination.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("aster-project");
    let staging = parent.join(format!(".{name}.{}.unpacking", Uuid::new_v4()));
    let result = (|| {
        fs::create_dir(&staging)?;
        let mut archive = ZipArchive::new(BufReader::new(File::open(archive_path)?))?;
        if archive.len() > MAX_PACKED_ENTRIES {
            return Err(ProjectError::PackedEntryLimit);
        }
        let mut total_bytes = 0_u64;
        let mut project_entries = 0_usize;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index)?;
            if entry
                .unix_mode()
                .is_some_and(|mode| mode & 0o170000 == 0o120000)
            {
                return Err(ProjectError::UnsafePackedPath(PathBuf::from(entry.name())));
            }
            let enclosed = entry
                .enclosed_name()
                .ok_or_else(|| ProjectError::UnsafePackedPath(PathBuf::from(entry.name())))?;
            if enclosed == Path::new(PROJECT_FILE) {
                project_entries += 1;
            } else if !enclosed.starts_with("assets") {
                return Err(ProjectError::UnsafePackedPath(enclosed.to_owned()));
            }
            total_bytes = total_bytes.saturating_add(entry.size());
            if total_bytes > MAX_PACKED_BYTES {
                return Err(ProjectError::PackedSizeLimit);
            }
            let target = staging.join(enclosed);
            if entry.is_dir() {
                fs::create_dir_all(target)?;
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            let expected_size = entry.size();
            let mut output = BufWriter::new(File::create(target)?);
            let copied = io::copy(&mut entry.by_ref().take(expected_size + 1), &mut output)?;
            if copied != expected_size {
                return Err(ProjectError::PackedSizeLimit);
            }
            output.flush()?;
        }
        if project_entries != 1 {
            return Err(ProjectError::InvalidPackedProject);
        }
        load_editor_bundle(&staging)?;
        replace_directory(&staging, destination)?;
        Ok(())
    })();
    if result.is_err() && staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
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
    if version != EDITOR_SCHEMA_VERSION {
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
    if project.schema_version != Project::SCHEMA_VERSION {
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

fn replace_directory(temporary: &Path, destination: &Path) -> Result<(), std::io::Error> {
    if !destination.exists() {
        return fs::rename(temporary, destination);
    }
    let backup = destination.with_extension(format!("backup-{}", Uuid::new_v4()));
    fs::rename(destination, &backup)?;
    match fs::rename(temporary, destination) {
        Ok(()) => {
            fs::remove_dir_all(backup)?;
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(backup, destination);
            Err(error)
        }
    }
}

fn packed_asset_files(directory: &Path) -> Result<Vec<PathBuf>, ProjectError> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut pending = vec![directory.to_owned()];
    let mut files = Vec::new();
    while let Some(current) = pending.pop() {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() {
                return Err(ProjectError::UnsafePackedPath(entry.path()));
            }
            if metadata.is_dir() {
                pending.push(entry.path());
            } else if metadata.is_file() {
                files.push(entry.path());
            }
        }
    }
    Ok(files)
}

fn archive_path(path: &Path) -> Result<String, ProjectError> {
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err(ProjectError::UnsafePackedPath(path.to_owned()));
        };
        parts.push(part.to_string_lossy());
    }
    Ok(parts.join("/"))
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
    let extension = destination
        .extension()
        .and_then(|extension| extension.to_str())
        .map_or_else(
            || "backup".to_owned(),
            |extension| format!("{extension}.backup"),
        );
    destination.with_extension(extension)
}

#[derive(Debug, Error)]
pub enum ProjectError {
    #[error("project I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("project JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
    #[error("project schema {found} is not supported; expected schema {supported}")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("project contains no compositions")]
    NoCompositions,
    #[error("active composition is missing")]
    MissingActiveComposition,
    #[error("editor project is invalid: {0}")]
    InvalidEditorDocument(&'static str),
    #[error("packed project contains an unsafe path: {0}")]
    UnsafePackedPath(PathBuf),
    #[error("packed project exceeds the entry limit")]
    PackedEntryLimit,
    #[error("packed project exceeds the uncompressed size limit")]
    PackedSizeLimit,
    #[error("packed project must contain exactly one project.json")]
    InvalidPackedProject,
    #[error("packed project ZIP is invalid: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("disk cache key must contain only ASCII letters, digits, underscore, or hyphen")]
    InvalidCacheKey,
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
            "schemaVersion": 1,
            "id": Uuid::new_v4().to_string(),
            "name": "Editor roundtrip",
            "activeCompositionId": "main",
            "compositions": [{ "id": "main", "layers": [] }],
            "updatedAt": "2026-08-20T00:00:00.000Z",
            "commandLog": [],
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

    #[test]
    fn packed_editor_bundle_roundtrips_project_and_assets() {
        let root = std::env::temp_dir().join(format!("aster-packed-test-{}", Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("unpacked");
        let archive = root.join("project.aster");
        let expected = editor_project();
        fs::create_dir_all(source.join("assets/nested")).unwrap();
        save_editor_bundle(&source, &expected).unwrap();
        fs::write(source.join("assets/nested/texture.bin"), b"gpu asset").unwrap();

        pack_editor_bundle(&source, &archive).unwrap();
        unpack_editor_bundle(&archive, &destination).unwrap();

        assert_eq!(load_editor_bundle(&destination).unwrap(), expected);
        assert_eq!(
            fs::read(destination.join("assets/nested/texture.bin")).unwrap(),
            b"gpu asset"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn packed_editor_bundle_rejects_path_traversal() {
        let root = std::env::temp_dir().join(format!("aster-packed-unsafe-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive_path = root.join("unsafe.aster");
        let mut archive = ZipWriter::new(File::create(&archive_path).unwrap());
        archive
            .start_file("../escape.txt", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"escape").unwrap();
        archive.finish().unwrap();

        assert!(matches!(
            unpack_editor_bundle(&archive_path, root.join("unpacked")),
            Err(ProjectError::UnsafePackedPath(_))
        ));
        assert!(!root.join("escape.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn editor_validation_rejects_legacy_schema() {
        let mut legacy = editor_project();
        legacy["schemaVersion"] = Value::from(0);
        assert!(matches!(
            validate_editor_project(&legacy),
            Err(ProjectError::UnsupportedSchema { found: 0, .. })
        ));
    }
}

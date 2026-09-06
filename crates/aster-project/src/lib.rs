//! Git-friendly project bundle persistence.

mod atomic_file;
mod bundle_access;
use bundle_access::BundleAccess;
mod disk_cache;
mod proxy;

pub use atomic_file::AtomicFile;
pub use disk_cache::{DiskCache, DiskCacheBenchmark, DiskCacheStatistics};
pub use proxy::{
    CancellationToken, ProxyCache, ProxyError, ProxyGenerationPlan, ProxyLimits, ProxyMetadata,
    ProxyProfile, ProxyValidity,
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

#[derive(Clone, Debug, clap::Args)]
pub struct BundleLimits {
    #[arg(long, default_value_t = Self::default().max_packed_entries)]
    pub max_packed_entries: usize,
    #[arg(long, default_value_t = Self::default().max_packed_bytes)]
    pub max_packed_bytes: u64,
}

impl Default for BundleLimits {
    fn default() -> Self {
        Self {
            max_packed_entries: 4_096,
            max_packed_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

pub struct ProjectBundle {
    pub root: PathBuf,
    pub limits: BundleLimits,
}

impl ProjectBundle {
    pub const PROJECT_FILE: &str = "project.json";
    pub const AUTOSAVE_FILE: &str = "project.autosave.json";
    pub const EDITOR_SCHEMA_VERSION: u64 = 10;

    pub fn at(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_owned(),
            limits: BundleLimits::default(),
        }
    }

    pub fn prepare_directory(&self) -> Result<PathBuf, ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        fs::create_dir_all(&self.root)?;
        Ok(self.root.canonicalize()?)
    }
    pub fn save_core(&self, project: &Project) -> Result<(), ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        Self::validate_core(project)?;
        Self::write_json_atomic(self.root.as_path(), Self::PROJECT_FILE, project)
    }

    pub fn load_core(&self) -> Result<Project, ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        let path = self.root.as_path().join(Self::PROJECT_FILE);
        let project: Project = serde_json::from_reader(BufReader::new(File::open(path)?))?;
        Self::validate_core(&project)?;
        Ok(project)
    }

    pub fn save_editor(&self, project: &Value) -> Result<(), ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        Self::validate_editor(project, false)?;
        Self::write_json_atomic(self.root.as_path(), Self::PROJECT_FILE, project)
    }

    pub fn load_editor(&self) -> Result<Value, ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        let project: Value = serde_json::from_reader(BufReader::new(File::open(
            self.root.as_path().join(Self::PROJECT_FILE),
        )?))?;
        Self::validate_editor(&project, true)?;
        Ok(project)
    }

    pub fn pack(&self, destination: impl AsRef<Path>) -> Result<(), ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        let bundle = self.root.as_path().canonicalize()?;
        let project: Value =
            serde_json::from_reader(BufReader::new(File::open(bundle.join(Self::PROJECT_FILE))?))?;
        Self::validate_editor(&project, true)?;
        let destination = destination.as_ref();
        AtomicFile::write(destination, |file| {
            let mut archive = ZipWriter::new(BufWriter::new(file));
            let options = SimpleFileOptions::default()
                .compression_method(CompressionMethod::Deflated)
                .unix_permissions(0o644);
            archive.start_file(Self::PROJECT_FILE, options)?;
            serde_json::to_writer_pretty(&mut archive, &project)?;
            archive.write_all(b"\n")?;
            let assets = bundle.join("assets");
            let mut files = self.packed_asset_files(&assets)?;
            files.sort();
            if files.len() + 1 > self.limits.max_packed_entries {
                return Err(ProjectError::PackedEntryLimit);
            }
            let mut total_bytes = serde_json::to_vec_pretty(&project)?.len() as u64 + 1;
            if total_bytes > self.limits.max_packed_bytes {
                return Err(ProjectError::PackedSizeLimit);
            }
            for source in files {
                let metadata = fs::symlink_metadata(&source)?;
                if Self::is_link(&metadata) || !metadata.is_file() {
                    return Err(ProjectError::UnsafePackedPath(source));
                }
                total_bytes = total_bytes.saturating_add(metadata.len());
                if total_bytes > self.limits.max_packed_bytes {
                    return Err(ProjectError::PackedSizeLimit);
                }
                let relative = source
                    .strip_prefix(&bundle)
                    .map_err(|_| ProjectError::UnsafePackedPath(source.clone()))?;
                let name = Self::archive_path(relative)?;
                archive.start_file(name, options)?;
                let copied = io::copy(
                    &mut BufReader::new(File::open(source)?).take(metadata.len().saturating_add(1)),
                    &mut archive,
                )?;
                if copied != metadata.len() {
                    return Err(ProjectError::PackedSizeLimit);
                }
            }
            let mut writer = archive.finish()?;
            writer.flush()?;
            Ok(())
        })
    }

    pub fn unpack(&self, archive_path: impl AsRef<Path>) -> Result<(), ProjectError> {
        let access = BundleAccess::acquire(&self.root)?;
        let archive_path = archive_path.as_ref();
        let destination = self.root.as_path();
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
            if archive.len() > self.limits.max_packed_entries {
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
                if enclosed == Path::new(Self::PROJECT_FILE) {
                    project_entries += 1;
                } else if !enclosed.starts_with("assets") {
                    return Err(ProjectError::UnsafePackedPath(enclosed.to_owned()));
                }
                total_bytes = total_bytes.saturating_add(entry.size());
                if total_bytes > self.limits.max_packed_bytes {
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
                let copied = io::copy(
                    &mut entry.by_ref().take(expected_size.saturating_add(1)),
                    &mut output,
                )?;
                if copied != expected_size {
                    return Err(ProjectError::PackedSizeLimit);
                }
                output.flush()?;
                output.get_ref().sync_all()?;
            }
            if project_entries != 1 {
                return Err(ProjectError::InvalidPackedProject);
            }
            Self::at(&staging).load_editor()?;
            access.replace(&staging)?;
            Ok(())
        })();
        if result.is_err() && staging.exists() {
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }

    pub fn save_autosave(&self, project: &Value) -> Result<(), ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        Self::validate_editor(project, false)?;
        Self::write_json_atomic(self.root.as_path(), Self::AUTOSAVE_FILE, project)
    }

    pub fn recovery_candidate(&self) -> Result<Option<Value>, ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        let bundle = self.root.as_path();
        let autosave_path = bundle.join(Self::AUTOSAVE_FILE);
        if !autosave_path.exists() {
            return Ok(None);
        }
        let project_path = bundle.join(Self::PROJECT_FILE);
        if project_path.exists()
            && fs::metadata(&autosave_path)?.modified()?
                <= fs::metadata(project_path)?.modified()?
        {
            return Ok(None);
        }
        let project = serde_json::from_reader(BufReader::new(File::open(autosave_path)?))?;
        Self::validate_editor(&project, true)?;
        Ok(Some(project))
    }

    pub fn clear_autosave(&self) -> Result<(), ProjectError> {
        let _access = BundleAccess::acquire(&self.root)?;
        let path = self.root.as_path().join(Self::AUTOSAVE_FILE);
        if path.exists() {
            fs::remove_file(path)?;
        }
        Ok(())
    }

    pub fn validate_editor(project: &Value, allow_legacy: bool) -> Result<(), ProjectError> {
        let object = project
            .as_object()
            .ok_or(ProjectError::InvalidEditorDocument(
                "project root must be an object",
            ))?;
        let version = object.get("schemaVersion").and_then(Value::as_u64).ok_or(
            ProjectError::InvalidEditorDocument("schemaVersion must be an unsigned integer"),
        )?;
        if version > Self::EDITOR_SCHEMA_VERSION
            || (allow_legacy && version < 1)
            || (!allow_legacy && version != Self::EDITOR_SCHEMA_VERSION)
        {
            return Err(ProjectError::UnsupportedSchema {
                found: u32::try_from(version).unwrap_or(u32::MAX),
                supported: Self::EDITOR_SCHEMA_VERSION as u32,
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

    pub fn validate_core(project: &Project) -> Result<(), ProjectError> {
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

    fn packed_asset_files(&self, directory: &Path) -> Result<Vec<PathBuf>, ProjectError> {
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let root_metadata = fs::symlink_metadata(directory)?;
        if Self::is_link(&root_metadata) {
            return Err(ProjectError::UnsafePackedPath(directory.to_owned()));
        }
        let mut pending = vec![directory.to_owned()];
        let mut files = Vec::new();
        while let Some(current) = pending.pop() {
            for entry in fs::read_dir(current)? {
                let entry = entry?;
                let metadata = fs::symlink_metadata(entry.path())?;
                if Self::is_link(&metadata) {
                    return Err(ProjectError::UnsafePackedPath(entry.path()));
                }
                if metadata.is_dir() {
                    pending.push(entry.path());
                } else if metadata.is_file() {
                    files.push(entry.path());
                    if files.len() >= self.limits.max_packed_entries {
                        return Err(ProjectError::PackedEntryLimit);
                    }
                }
            }
        }
        Ok(files)
    }

    fn is_link(metadata: &fs::Metadata) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
        }
        #[cfg(not(windows))]
        {
            metadata.file_type().is_symlink()
        }
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
        AtomicFile::write(&bundle.join(file_name), |file| {
            let mut writer = BufWriter::new(file);
            serde_json::to_writer_pretty(&mut writer, value)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            Ok(())
        })
    }
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
mod tests;

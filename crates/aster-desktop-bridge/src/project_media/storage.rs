use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

use super::validation::{object_mut, required_string, safe_relative_path};
use super::{MAX_BUNDLE_MEDIA_BYTES, MAX_MEDIA_FILES, MAX_PORTABLE_BYTES};

#[derive(Default)]
pub(super) struct MediaBudget {
    files: usize,
    unique: BTreeMap<String, u64>,
}

impl MediaBudget {
    fn charge(&mut self, identity: &str, bytes: u64) -> Result<(), String> {
        self.files = self.files.saturating_add(1);
        if self.files > MAX_MEDIA_FILES {
            return Err("project media import exceeds the file entry limit".to_owned());
        }
        self.unique.entry(identity.to_owned()).or_insert(bytes);
        let total = self
            .unique
            .values()
            .try_fold(0_u64, |total, bytes| total.checked_add(*bytes))
            .ok_or_else(|| "project media import size overflowed".to_owned())?;
        if total > MAX_BUNDLE_MEDIA_BYTES {
            return Err("project media imports exceed 2 GiB".to_owned());
        }
        Ok(())
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn materialize_storage(
    bundle: &Path,
    storage: &mut Value,
    extension: &str,
    expected_identity: Option<&str>,
    expected_size: Option<u64>,
    expected_last_modified: Option<u64>,
    maximum_size: u64,
    path: &str,
    budget: &mut MediaBudget,
) -> Result<(), String> {
    let object = object_mut(storage, &format!("{path}.storage"))?;
    if object.contains_key("runtimeUrl") {
        return Err(format!("{path}.storage.runtimeUrl must not be persisted"));
    }
    object.remove("resolvedPath");
    let kind = required_string(object, "kind", &format!("{path}.storage.kind"))?;
    if kind == "relative" {
        let relative = safe_relative_path(required_string(
            object,
            "relativePath",
            &format!("{path}.storage.relativePath"),
        )?)?;
        let identity = required_string(
            object,
            "byteIdentity",
            &format!("{path}.storage.byteIdentity"),
        )?
        .to_owned();
        let source = secure_existing_bundle_file(bundle, &relative, path)?;
        let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
        validate_maximum_size(metadata.len(), maximum_size, path)?;
        validate_expected_size(expected_size, metadata.len(), path)?;
        let actual = fnv64_file_identity(&source)?;
        validate_identity(&identity, &actual, path)?;
        if let Some(expected) = expected_identity {
            validate_identity(expected, &actual, path)?;
        }
        budget.charge(&actual, metadata.len())?;
        return Ok(());
    }

    let (source, owned_bytes, declared_identity) = if kind == "inline" {
        let identity = required_string(
            object,
            "byteIdentity",
            &format!("{path}.storage.byteIdentity"),
        )?
        .to_owned();
        let declared_bytes = identity_byte_length(&identity)?;
        validate_maximum_size(declared_bytes, maximum_size.min(MAX_PORTABLE_BYTES), path)?;
        let encoded = required_string(object, "data", &format!("{path}.storage.data"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| format!("{path}.storage.data is invalid base64"))?;
        if bytes.len() as u64 != declared_bytes {
            return Err(format!(
                "{path} inline byte length does not match its identity"
            ));
        }
        let actual = fnv64_bytes_identity(&bytes);
        validate_identity(&identity, &actual, path)?;
        (None, Some(bytes), actual)
    } else if kind == "external" {
        let external = PathBuf::from(required_string(
            object,
            "externalPath",
            &format!("{path}.storage.externalPath"),
        )?)
        .canonicalize()
        .map_err(|_| format!("{path} external media file is missing"))?;
        if !external.is_file() {
            return Err(format!("{path} external media payload is not a file"));
        }
        let metadata = fs::metadata(&external).map_err(|error| error.to_string())?;
        validate_maximum_size(metadata.len(), maximum_size, path)?;
        if object.get("byteIdentity").is_none() {
            validate_expected_last_modified(expected_last_modified, &metadata, path)?;
        }
        let actual = fnv64_file_identity(&external)?;
        if let Some(identity) = object.get("byteIdentity").and_then(Value::as_str) {
            validate_identity(identity, &actual, path)?;
        }
        (Some(external), None, actual)
    } else {
        return Err(format!("{path}.storage.kind is unsupported"));
    };

    if let Some(expected) = expected_identity {
        validate_identity(expected, &declared_identity, path)?;
    }
    let byte_length = owned_bytes
        .as_ref()
        .map(|bytes| bytes.len() as u64)
        .or_else(|| {
            source
                .as_ref()
                .and_then(|path| fs::metadata(path).ok().map(|value| value.len()))
        })
        .ok_or_else(|| format!("{path} media payload size is unavailable"))?;
    validate_expected_size(expected_size, byte_length, path)?;
    budget.charge(&declared_identity, byte_length)?;

    let relative = import_relative_path(&declared_identity, extension);
    let destination = secure_managed_destination(bundle, &relative, path)?;
    if destination.exists() {
        let existing = fnv64_file_identity(&destination)?;
        validate_identity(&declared_identity, &existing, path)?;
    } else if let Some(bytes) = owned_bytes {
        write_atomic(&destination, |file| file.write_all(&bytes))?;
    } else if let Some(source) = source {
        write_atomic(&destination, |file| {
            std::io::copy(&mut BufReader::new(File::open(source)?), file).map(|_| ())
        })?;
    }
    *storage = json!({
        "kind": "relative",
        "relativePath": slash_path(&relative),
        "byteIdentity": declared_identity,
    });
    Ok(())
}

pub(super) fn resolve_storage(
    bundle: &Path,
    storage: &mut Value,
    expected_identity: Option<&str>,
    expected_size: Option<u64>,
    maximum_size: u64,
    path: &str,
    budget: &mut MediaBudget,
) -> Result<PathBuf, String> {
    let object = object_mut(storage, &format!("{path}.storage"))?;
    if required_string(object, "kind", &format!("{path}.storage.kind"))? != "relative" {
        return Err(format!(
            "{path} project media was not materialized into the bundle"
        ));
    }
    let relative = safe_relative_path(required_string(
        object,
        "relativePath",
        &format!("{path}.storage.relativePath"),
    )?)?;
    let identity = required_string(
        object,
        "byteIdentity",
        &format!("{path}.storage.byteIdentity"),
    )?
    .to_owned();
    let bundle = bundle.canonicalize().map_err(|error| error.to_string())?;
    let resolved = secure_existing_bundle_file(&bundle, &relative, path)?;
    let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
    validate_maximum_size(metadata.len(), maximum_size, path)?;
    validate_expected_size(expected_size, metadata.len(), path)?;
    let actual = fnv64_file_identity(&resolved)?;
    validate_identity(&identity, &actual, path)?;
    if let Some(expected) = expected_identity {
        validate_identity(expected, &actual, path)?;
    }
    budget.charge(&identity, metadata.len())?;
    object.insert(
        "resolvedPath".to_owned(),
        Value::String(resolved.to_string_lossy().into_owned()),
    );
    Ok(resolved)
}

fn secure_existing_bundle_file(
    bundle: &Path,
    relative: &Path,
    path: &str,
) -> Result<PathBuf, String> {
    let mut candidate = bundle.to_owned();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err("project media relativePath must stay inside the bundle".to_owned());
        };
        candidate.push(component);
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|_| format!("{path} media file is missing from the project bundle"))?;
        if is_link_like(&metadata) {
            return Err(format!(
                "{path} media path must not contain a link or reparse point"
            ));
        }
    }
    let resolved = candidate
        .canonicalize()
        .map_err(|_| format!("{path} media file is missing from the project bundle"))?;
    if !resolved.starts_with(bundle) {
        return Err(format!(
            "{path} media path resolves outside the project bundle"
        ));
    }
    if !fs::metadata(&resolved)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err(format!("{path} media payload is not a file"));
    }
    Ok(resolved)
}

fn secure_managed_destination(
    bundle: &Path,
    relative: &Path,
    path: &str,
) -> Result<PathBuf, String> {
    let parent = relative
        .parent()
        .ok_or_else(|| format!("{path} media destination has no parent"))?;
    let mut current = bundle.to_owned();
    for component in parent.components() {
        let Component::Normal(component) = component else {
            return Err("project media relativePath must stay inside the bundle".to_owned());
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_link_like(&metadata) {
                    return Err(format!(
                        "{path} media destination must not contain a link or reparse point"
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!(
                        "{path} media destination parent is not a directory"
                    ));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        let resolved = current.canonicalize().map_err(|error| error.to_string())?;
        if !resolved.starts_with(bundle) {
            return Err(format!(
                "{path} media destination resolves outside the project bundle"
            ));
        }
    }
    let destination = bundle.join(relative);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if is_link_like(&metadata) {
            return Err(format!(
                "{path} media destination must not be a link or reparse point"
            ));
        }
        let resolved = destination
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !resolved.starts_with(bundle) {
            return Err(format!(
                "{path} media destination resolves outside the project bundle"
            ));
        }
    }
    Ok(destination)
}

#[cfg(windows)]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

pub(super) fn import_relative_path(identity: &str, extension: &str) -> PathBuf {
    let digest = Sha256::digest(identity.as_bytes());
    PathBuf::from("assets")
        .join("imports")
        .join(format!("{:x}{extension}", digest))
}

pub(super) fn slash_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn write_atomic<F>(destination: &Path, write: F) -> Result<(), String>
where
    F: FnOnce(&mut File) -> std::io::Result<()>,
{
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("media");
    let temporary = destination.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = File::create(&temporary)?;
        write(&mut file)?;
        file.flush()?;
        file.sync_all()?;
        fs::rename(&temporary, destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| error.to_string())
}

fn validate_expected_size(expected: Option<u64>, actual: u64, path: &str) -> Result<(), String> {
    if expected.is_some_and(|expected| expected != actual) {
        return Err(format!("{path} byte size changed before save"));
    }
    Ok(())
}

fn validate_maximum_size(actual: u64, maximum: u64, path: &str) -> Result<(), String> {
    if actual > maximum {
        return Err(format!("{path} media payload exceeds its size limit"));
    }
    Ok(())
}

fn validate_expected_last_modified(
    expected: Option<u64>,
    metadata: &fs::Metadata,
    path: &str,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let actual = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    if actual != u128::from(expected) {
        return Err(format!("{path} modification time changed before save"));
    }
    Ok(())
}

fn validate_identity(expected: &str, actual: &str, path: &str) -> Result<(), String> {
    if expected != actual {
        return Err(format!("{path} identity mismatch"));
    }
    Ok(())
}

fn identity_byte_length(identity: &str) -> Result<u64, String> {
    let mut parts = identity.split(':');
    if parts.next() != Some("fnv64")
        || parts.next().is_none_or(|hash| {
            hash.len() != 16 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    {
        return Err("project media byte identity is unsupported".to_owned());
    }
    let bytes = parts
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "project media byte identity length is invalid".to_owned())?;
    if parts.next().is_some() {
        return Err("project media byte identity is unsupported".to_owned());
    }
    Ok(bytes)
}

fn fnv64_file_identity(path: &Path) -> Result<String, String> {
    let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let mut state = Fnv64State::default();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        state.update(&buffer[..count]);
    }
    Ok(state.identity())
}

pub(super) fn fnv64_bytes_identity(bytes: &[u8]) -> String {
    let mut state = Fnv64State::default();
    state.update(bytes);
    state.identity()
}

struct Fnv64State {
    left: u32,
    right: u32,
    bytes: u64,
}

impl Default for Fnv64State {
    fn default() -> Self {
        Self {
            left: 0x811c9dc5,
            right: 0x9e3779b9,
            bytes: 0,
        }
    }
}

impl Fnv64State {
    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.left = (self.left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            self.right = (self.right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        self.bytes = self.bytes.saturating_add(bytes.len() as u64);
    }

    fn identity(&self) -> String {
        format!("fnv64:{:08x}{:08x}:{}", self.left, self.right, self.bytes)
    }
}

use super::{
    media_file::{Fnv64State, MediaFiles},
    validation::{
        identity_byte_length, object_mut, required_string, safe_relative_path,
        validate_expected_last_modified, validate_expected_size, validate_identity,
        validate_maximum_size,
    },
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
};

#[derive(Default)]
pub(super) struct MediaBudget {
    pub(super) limits: super::MediaLimits,
    pub(super) files: usize,
    pub(super) unique: BTreeMap<String, u64>,
}

impl MediaBudget {
    fn charge(&mut self, identity: &str, bytes: u64) -> Result<(), String> {
        self.files = self.files.saturating_add(1);
        if self.files > self.limits.max_media_files {
            return Err("project media import exceeds the file entry limit".to_owned());
        }
        self.unique.entry(identity.to_owned()).or_insert(bytes);
        let total = self
            .unique
            .values()
            .try_fold(0_u64, |total, bytes| total.checked_add(*bytes))
            .ok_or_else(|| "project media import size overflowed".to_owned())?;
        if total > self.limits.max_bundle_media_bytes {
            return Err("project media imports exceed the configured byte limit".to_owned());
        }
        Ok(())
    }
}

#[derive(Default)]
pub(super) struct MediaPayload {
    pub extension: String,
    pub expected_identity: Option<String>,
    pub expected_sha256: Option<String>,
    pub expected_size: Option<u64>,
    pub expected_last_modified: Option<u64>,
    pub maximum_size: u64,
    pub path: String,
}

impl MediaPayload {
    pub(super) fn materialize(
        &self,
        bundle: &Path,
        storage: &mut Value,
        budget: &mut MediaBudget,
    ) -> Result<(), String> {
        let path = self.path.as_str();
        let expected_identity = self.expected_identity.as_deref();
        let expected_sha256 = self.expected_sha256.as_deref();
        let expected_size = self.expected_size;
        let maximum_size = self.maximum_size;
        let files = MediaFiles {
            root: bundle.to_owned(),
        };
        let extension = &self.extension;
        let expected_last_modified = self.expected_last_modified;

        let object = object_mut(storage, format!("{path}.storage"))?;
        if object.contains_key("runtimeUrl") {
            return Err(format!("{path}.storage.runtimeUrl must not be persisted"));
        }
        object.remove("resolvedPath");
        let kind = required_string(object, "kind", format!("{path}.storage.kind"))?;
        if kind == "relative" {
            self.relative_file(&files, object, budget)?;
            return Ok(());
        }

        let (source, owned_bytes, declared_identity, sha256_identity) = if kind == "inline" {
            let identity = required_string(
                object,
                "byteIdentity",
                format!("{path}.storage.byteIdentity"),
            )?
            .to_owned();
            let declared_bytes = identity_byte_length(&identity)?;
            validate_maximum_size(
                declared_bytes,
                maximum_size.min(budget.limits.max_portable_bytes),
                path,
            )?;
            let encoded = object
                .get("data")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{path}.storage.data must be a string"))?;
            // Check encoded size before allocating the decoded payload. Metadata string limits do not apply to media.
            let encoded_length = declared_bytes
                .div_ceil(3)
                .checked_mul(4)
                .ok_or_else(|| format!("{path} encoded size overflowed"))?;
            if encoded.len() as u64 != encoded_length {
                return Err(format!(
                    "{path}.storage.data length does not match its identity"
                ));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|_| format!("{path}.storage.data is invalid base64"))?;
            if bytes.len() as u64 != declared_bytes {
                return Err(format!(
                    "{path} inline byte length does not match its identity"
                ));
            }
            let actual = Fnv64State::bytes_identity(&bytes);
            validate_identity(&identity, &actual, path)?;
            let sha256 = format!("sha256:{:x}", Sha256::digest(&bytes));
            (None, Some(bytes), actual, sha256)
        } else if kind == "external" {
            let external = PathBuf::from(required_string(
                object,
                "externalPath",
                format!("{path}.storage.externalPath"),
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
            let (actual, sha256) = Fnv64State::file_identities(&external, maximum_size)?;
            if let Some(identity) = object.get("byteIdentity").and_then(Value::as_str) {
                validate_identity(identity, &actual, path)?;
            }
            (Some(external), None, actual, sha256)
        } else {
            return Err(format!("{path}.storage.kind is unsupported"));
        };

        if let Some(expected) = expected_identity {
            validate_identity(expected, &declared_identity, path)?;
        }
        if let Some(expected) = expected_sha256 {
            validate_identity(expected, &sha256_identity, path)?;
        }
        let byte_length = identity_byte_length(&declared_identity)?;
        validate_expected_size(expected_size, byte_length, path)?;
        budget.charge(&declared_identity, byte_length)?;

        let relative = MediaFiles::import_relative_path(&declared_identity, extension);
        let destination = files.destination(&relative, path)?;
        if destination.exists() {
            let (existing, sha256) = Fnv64State::file_identities(&destination, maximum_size)?;
            validate_identity(&declared_identity, &existing, path)?;
            validate_identity(&sha256_identity, &sha256, path)?;
        } else if let Some(bytes) = owned_bytes {
            let (pending, mut file) = aster_project::AtomicFile::stage(&destination)
                .map_err(|error| error.to_string())?;
            file.write_all(&bytes).map_err(|error| error.to_string())?;
            drop(file);
            pending.publish(false).map_err(|error| error.to_string())?;
        } else if let Some(source) = source {
            let (pending, mut file) = aster_project::AtomicFile::stage(&destination)
                .map_err(|error| error.to_string())?;
            let mut reader = BufReader::new(File::open(source).map_err(|error| error.to_string())?)
                .take(maximum_size.saturating_add(1));
            let copied =
                std::io::copy(&mut reader, &mut file).map_err(|error| error.to_string())?;
            drop(file);
            validate_maximum_size(copied, maximum_size, path)?;
            let (actual, sha256) = Fnv64State::file_identities(&pending.temporary, maximum_size)?;
            validate_identity(&declared_identity, &actual, path)?;
            validate_identity(&sha256_identity, &sha256, path)?;
            pending.publish(false).map_err(|error| error.to_string())?;
        }
        *storage = serde_json::to_value(RelativeStorage {
            kind: RelativeStorageKind::Relative,
            relative_path: MediaFiles::slash_path(&relative),
            byte_identity: declared_identity,
        })
        .map_err(|error| error.to_string())?;
        Ok(())
    }
    pub(super) fn resolve(
        &self,
        bundle: &Path,
        storage: &mut Value,
        budget: &mut MediaBudget,
    ) -> Result<PathBuf, String> {
        let path = self.path.as_str();
        let files = MediaFiles {
            root: bundle.to_owned(),
        };

        let object = object_mut(storage, format!("{path}.storage"))?;
        if required_string(object, "kind", format!("{path}.storage.kind"))? != "relative" {
            return Err(format!(
                "{path} project media was not materialized into the bundle"
            ));
        }
        let resolved = self.relative_file(&files, object, budget)?;
        object.insert(
            "resolvedPath".to_owned(),
            Value::String(resolved.to_string_lossy().into_owned()),
        );
        Ok(resolved)
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RelativeStorage {
    kind: RelativeStorageKind,
    relative_path: String,
    byte_identity: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum RelativeStorageKind {
    Relative,
}

impl MediaPayload {
    fn relative_file(
        &self,
        files: &MediaFiles,
        object: &serde_json::Map<String, Value>,
        budget: &mut MediaBudget,
    ) -> Result<PathBuf, String> {
        let path = self.path.as_str();
        let expected_identity = self.expected_identity.as_deref();
        let expected_sha256 = self.expected_sha256.as_deref();
        let expected_size = self.expected_size;
        let maximum_size = self.maximum_size;
        let relative = safe_relative_path(required_string(
            object,
            "relativePath",
            format!("{path}.storage.relativePath"),
        )?)?;
        let identity = required_string(
            object,
            "byteIdentity",
            format!("{path}.storage.byteIdentity"),
        )?
        .to_owned();
        let resolved = files.existing(&relative, path)?;
        let metadata = fs::metadata(&resolved).map_err(|error| error.to_string())?;
        validate_maximum_size(metadata.len(), maximum_size, path)?;

        let (actual, sha256) = Fnv64State::file_identities(&resolved, maximum_size)?;
        validate_identity(&identity, &actual, path)?;
        if let Some(expected) = expected_identity {
            validate_identity(expected, &actual, path)?;
        }
        if let Some(expected) = expected_sha256 {
            validate_identity(expected, &sha256, path)?;
        }
        let size = identity_byte_length(&actual)?;
        validate_expected_size(expected_size, size, path)?;
        budget.charge(&identity, size)?;
        Ok(resolved)
    }
}

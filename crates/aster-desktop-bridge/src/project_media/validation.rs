use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};

use super::ProjectMedia;
use std::fs;

pub(super) fn sidecar_mut(project: &mut Value) -> Result<Option<&mut Map<String, Value>>, String> {
    let Some(sidecar) = project.get_mut("mediaImports") else {
        return Ok(None);
    };
    let sidecar = object_mut(sidecar, "mediaImports")?;
    if sidecar.get("version").and_then(Value::as_u64) != Some(ProjectMedia::SIDECAR_VERSION) {
        return Err("mediaImports.version is unsupported".to_owned());
    }
    Ok(Some(sidecar))
}

pub(super) fn bounded_array_mut(
    object: &mut Map<String, Value>,
    key: impl AsRef<str>,
    maximum: usize,
    path: impl std::fmt::Display,
) -> Result<&mut Vec<Value>, String> {
    let array = object
        .get_mut(key.as_ref())
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("{path} must be an array"))?;
    if array.len() > maximum {
        return Err(format!("{path} exceeds the entry limit"));
    }
    Ok(array)
}

pub(super) fn object_mut(
    value: &mut Value,
    path: impl std::fmt::Display,
) -> Result<&mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{path} must be an object"))
}

pub(super) fn required_mut(
    object: &mut Map<String, Value>,
    key: impl AsRef<str>,
    path: impl std::fmt::Display,
) -> Result<&mut Value, String> {
    object
        .get_mut(key.as_ref())
        .ok_or_else(|| format!("{path} is required"))
}

pub(super) fn required_string(
    object: &Map<String, Value>,
    key: impl AsRef<str>,
    path: impl std::fmt::Display,
) -> Result<&str, String> {
    let value = object
        .get(key.as_ref())
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{path} must be a string"))?;
    if value.is_empty() || value.len() > 4_096 {
        return Err(format!("{path} must be bounded"));
    }
    Ok(value)
}

pub(super) fn required_u64(
    object: &Map<String, Value>,
    key: impl AsRef<str>,
    path: &str,
) -> Result<u64, String> {
    object
        .get(key.as_ref())
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("{path} must be a non-negative integer"))
}

pub(super) fn safe_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("project media relativePath must stay inside the bundle".to_owned());
    }
    Ok(path.to_owned())
}

pub(super) fn image_extension(name: &str) -> Result<String, String> {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ![
        "avif", "bmp", "gif", "jpeg", "jpg", "png", "tif", "tiff", "webp",
    ]
    .contains(&extension.as_str())
    {
        return Err(format!(
            "image sequence frame {name} has an unsupported extension"
        ));
    }
    Ok(format!(".{extension}"))
}

pub(super) fn media_extension(value: &str, kind: &str) -> Result<String, String> {
    let extension = value
        .strip_prefix('.')
        .unwrap_or_default()
        .to_ascii_lowercase();
    let allowed = match kind {
        "still" => [
            "avif", "bmp", "gif", "jpeg", "jpg", "png", "tif", "tiff", "webp",
        ]
        .contains(&extension.as_str()),
        "audio" => ["aac", "flac", "m4a", "mp3", "ogg", "wav"].contains(&extension.as_str()),
        "video" => ["avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm"].contains(&extension.as_str()),
        _ => false,
    };
    if !allowed {
        return Err(format!("{kind} media has an unsupported extension {value}"));
    }
    Ok(format!(".{extension}"))
}

#[cfg(windows)]
pub(super) fn is_link_like(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
pub(super) fn is_link_like(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

pub(super) fn validate_expected_size(
    expected: Option<u64>,
    actual: u64,
    path: &str,
) -> Result<(), String> {
    if expected.is_some_and(|expected| expected != actual) {
        return Err(format!("{path} byte size changed before save"));
    }
    Ok(())
}

pub(super) fn validate_maximum_size(actual: u64, maximum: u64, path: &str) -> Result<(), String> {
    if actual > maximum {
        return Err(format!("{path} media payload exceeds its size limit"));
    }
    Ok(())
}

pub(super) fn validate_expected_last_modified(
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

pub(super) fn validate_identity(expected: &str, actual: &str, path: &str) -> Result<(), String> {
    if expected != actual {
        return Err(format!("{path} identity mismatch"));
    }
    Ok(())
}

pub(super) fn identity_byte_length(identity: &str) -> Result<u64, String> {
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

use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};

use super::SIDECAR_VERSION;

pub(super) fn sidecar_mut(project: &mut Value) -> Result<Option<&mut Map<String, Value>>, String> {
    let Some(sidecar) = project.get_mut("mediaImports") else {
        return Ok(None);
    };
    let sidecar = object_mut(sidecar, "mediaImports")?;
    if sidecar.get("version").and_then(Value::as_u64) != Some(SIDECAR_VERSION) {
        return Err("mediaImports.version is unsupported".to_owned());
    }
    Ok(Some(sidecar))
}

pub(super) fn bounded_array_mut<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
    maximum: usize,
    path: &str,
) -> Result<&'a mut Vec<Value>, String> {
    let array = object
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| format!("{path} must be an array"))?;
    if array.len() > maximum {
        return Err(format!("{path} exceeds the entry limit"));
    }
    Ok(array)
}

pub(super) fn object_mut<'a>(
    value: &'a mut Value,
    path: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    value
        .as_object_mut()
        .ok_or_else(|| format!("{path} must be an object"))
}

pub(super) fn required_mut<'a>(
    object: &'a mut Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<&'a mut Value, String> {
    object
        .get_mut(key)
        .ok_or_else(|| format!("{path} is required"))
}

pub(super) fn required_string<'a>(
    object: &'a Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<&'a str, String> {
    let value = object
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{path} must be a string"))?;
    if value.is_empty() || value.len() > 4_096 {
        return Err(format!("{path} must be bounded"));
    }
    Ok(value)
}

pub(super) fn required_u64(
    object: &Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<u64, String> {
    object
        .get(key)
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

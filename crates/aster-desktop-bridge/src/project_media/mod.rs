use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

mod storage;
mod validation;

use storage::{MediaBudget, materialize_storage, resolve_storage};
use validation::{
    bounded_array_mut, image_extension, object_mut, required_mut, required_string, required_u64,
    sidecar_mut,
};

const SIDECAR_VERSION: u64 = 1;
const MAX_PAYLOADS: usize = 50_000;
const MAX_MEDIA_FILES: usize = 4_096;
const MAX_PORTABLE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PSD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_BUNDLE_MEDIA_BYTES: u64 = 2 * 1024 * 1024 * 1024;

pub fn materialize_project_media(bundle: &Path, project: &mut Value) -> Result<(), String> {
    let Some(sidecar) = sidecar_mut(project)? else {
        return Ok(());
    };
    fs::create_dir_all(bundle).map_err(|error| error.to_string())?;
    let bundle = bundle.canonicalize().map_err(|error| error.to_string())?;
    let payloads = bounded_array_mut(sidecar, "payloads", MAX_PAYLOADS, "mediaImports.payloads")?;
    let mut budget = MediaBudget::default();
    for (payload_index, payload) in payloads.iter_mut().enumerate() {
        let path = format!("mediaImports.payloads[{payload_index}]");
        let payload = object_mut(payload, &path)?;
        match required_string(payload, "kind", &format!("{path}.kind"))? {
            "svg" => {
                let identity = required_string(
                    payload,
                    "contentIdentity",
                    &format!("{path}.contentIdentity"),
                )?
                .to_owned();
                let storage = required_mut(payload, "storage", &format!("{path}.storage"))?;
                materialize_storage(
                    &bundle,
                    storage,
                    ".svg",
                    Some(&identity),
                    None,
                    None,
                    MAX_PORTABLE_BYTES,
                    &path,
                    &mut budget,
                )?;
            }
            "psd" => {
                let identity = required_string(
                    payload,
                    "documentIdentity",
                    &format!("{path}.documentIdentity"),
                )?
                .to_owned();
                let storage = required_mut(payload, "storage", &format!("{path}.storage"))?;
                materialize_storage(
                    &bundle,
                    storage,
                    ".psd",
                    Some(&identity),
                    None,
                    None,
                    MAX_PSD_BYTES,
                    &path,
                    &mut budget,
                )?;
            }
            "imageSequence" => {
                let frames = bounded_array_mut(
                    payload,
                    "frames",
                    MAX_MEDIA_FILES,
                    &format!("{path}.frames"),
                )?;
                for (frame_index, frame) in frames.iter_mut().enumerate() {
                    let frame_path = format!("{path}.frames[{frame_index}]");
                    let frame = object_mut(frame, &frame_path)?;
                    let name = required_string(frame, "name", &format!("{frame_path}.name"))?;
                    let extension = image_extension(name)?;
                    let expected_size = required_u64(frame, "size", &format!("{frame_path}.size"))?;
                    let expected_last_modified =
                        required_u64(frame, "lastModified", &format!("{frame_path}.lastModified"))?;
                    let storage = required_mut(frame, "storage", &format!("{frame_path}.storage"))?;
                    materialize_storage(
                        &bundle,
                        storage,
                        &extension,
                        None,
                        Some(expected_size),
                        Some(expected_last_modified),
                        MAX_BUNDLE_MEDIA_BYTES,
                        &frame_path,
                        &mut budget,
                    )?;
                }
            }
            _ => return Err(format!("{path}.kind is unsupported")),
        }
    }
    Ok(())
}

pub fn resolve_project_media_paths(
    bundle: &Path,
    project: &mut Value,
) -> Result<Vec<PathBuf>, String> {
    let Some(sidecar) = sidecar_mut(project)? else {
        return Ok(Vec::new());
    };
    let payloads = bounded_array_mut(sidecar, "payloads", MAX_PAYLOADS, "mediaImports.payloads")?;
    let mut budget = MediaBudget::default();
    let mut resolved = Vec::new();
    for (payload_index, payload) in payloads.iter_mut().enumerate() {
        let path = format!("mediaImports.payloads[{payload_index}]");
        let payload = object_mut(payload, &path)?;
        match required_string(payload, "kind", &format!("{path}.kind"))? {
            "svg" => {
                let identity = required_string(
                    payload,
                    "contentIdentity",
                    &format!("{path}.contentIdentity"),
                )?
                .to_owned();
                let storage = required_mut(payload, "storage", &format!("{path}.storage"))?;
                resolved.push(resolve_storage(
                    bundle,
                    storage,
                    Some(&identity),
                    None,
                    MAX_PORTABLE_BYTES,
                    &path,
                    &mut budget,
                )?);
            }
            "psd" => {
                let identity = required_string(
                    payload,
                    "documentIdentity",
                    &format!("{path}.documentIdentity"),
                )?
                .to_owned();
                let storage = required_mut(payload, "storage", &format!("{path}.storage"))?;
                resolved.push(resolve_storage(
                    bundle,
                    storage,
                    Some(&identity),
                    None,
                    MAX_PSD_BYTES,
                    &path,
                    &mut budget,
                )?);
            }
            "imageSequence" => {
                let frames = bounded_array_mut(
                    payload,
                    "frames",
                    MAX_MEDIA_FILES,
                    &format!("{path}.frames"),
                )?;
                for (frame_index, frame) in frames.iter_mut().enumerate() {
                    let frame_path = format!("{path}.frames[{frame_index}]");
                    let frame = object_mut(frame, &frame_path)?;
                    let expected_size = required_u64(frame, "size", &format!("{frame_path}.size"))?;
                    let storage = required_mut(frame, "storage", &format!("{frame_path}.storage"))?;
                    resolved.push(resolve_storage(
                        bundle,
                        storage,
                        None,
                        Some(expected_size),
                        MAX_BUNDLE_MEDIA_BYTES,
                        &frame_path,
                        &mut budget,
                    )?);
                }
            }
            _ => return Err(format!("{path}.kind is unsupported")),
        }
    }
    Ok(resolved)
}

#[cfg(test)]
use storage::{fnv64_bytes_identity, import_relative_path, slash_path};
#[cfg(test)]
mod tests;

use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(crate) mod media_file;
mod storage;
mod validation;

use storage::{MediaBudget, MediaPayload};
use validation::{
    bounded_array_mut, image_extension, media_extension, object_mut, required_mut, required_string,
    required_u64, sidecar_mut,
};

#[derive(Clone, Debug, clap::Args)]
pub struct MediaLimits {
    #[arg(long, default_value_t = Self::default().max_payloads)]
    pub max_payloads: usize,
    #[arg(long, default_value_t = Self::default().max_media_files)]
    pub max_media_files: usize,
    #[arg(long, default_value_t = Self::default().max_portable_bytes)]
    pub max_portable_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_psd_bytes)]
    pub max_psd_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_footage_bytes)]
    pub max_footage_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_bundle_media_bytes)]
    pub max_bundle_media_bytes: u64,
}

impl Default for MediaLimits {
    fn default() -> Self {
        Self {
            max_payloads: 50_000,
            max_media_files: 4_096,
            max_portable_bytes: 128 * 1024 * 1024,
            max_psd_bytes: 512 * 1024 * 1024,
            max_footage_bytes: 96 * 1024 * 1024,
            max_bundle_media_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Default)]
pub(crate) struct ProjectMedia {
    pub limits: MediaLimits,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum MediaOperation {
    Materialize,
    Resolve,
}

impl ProjectMedia {
    const SIDECAR_VERSION: u64 = 1;

    pub(crate) fn process(
        &self,
        bundle: &Path,
        project: &mut Value,
        operation: MediaOperation,
    ) -> Result<Vec<PathBuf>, String> {
        let Some(sidecar) = sidecar_mut(project)? else {
            return Ok(Vec::new());
        };
        if operation == MediaOperation::Materialize {
            fs::create_dir_all(bundle).map_err(|error| error.to_string())?;
        }
        let bundle = bundle.canonicalize().map_err(|error| error.to_string())?;
        let payloads = bounded_array_mut(
            sidecar,
            "payloads",
            self.limits.max_payloads,
            "mediaImports.payloads",
        )?;
        let mut budget = MediaBudget {
            limits: self.limits.clone(),
            ..Default::default()
        };
        let mut resolved = Vec::new();
        for (index, payload) in payloads.iter_mut().enumerate() {
            let path = format!("mediaImports.payloads[{index}]");
            let payload = object_mut(payload, &path)?;
            let kind = required_string(payload, "kind", format!("{path}.kind"))?.to_owned();
            let mut items = Vec::new();
            if kind == "imageSequence" {
                let frames = bounded_array_mut(
                    payload,
                    "frames",
                    self.limits.max_media_files,
                    format!("{path}.frames"),
                )?;
                for (index, frame) in frames.iter_mut().enumerate() {
                    let path = format!("{path}.frames[{index}]");
                    let frame = object_mut(frame, &path)?;
                    let (extension, modified) = if operation == MediaOperation::Materialize {
                        (
                            image_extension(required_string(
                                frame,
                                "name",
                                format!("{path}.name"),
                            )?)?,
                            Some(required_u64(
                                frame,
                                "lastModified",
                                &format!("{path}.lastModified"),
                            )?),
                        )
                    } else {
                        (String::new(), None)
                    };
                    let request = MediaPayload {
                        extension,
                        expected_last_modified: modified,
                        expected_size: Some(required_u64(frame, "size", &format!("{path}.size"))?),
                        maximum_size: self.limits.max_bundle_media_bytes,
                        path: path.clone(),
                        ..Default::default()
                    };
                    items.push((
                        request,
                        required_mut(frame, "storage", format!("{path}.storage"))?,
                    ));
                }
            } else {
                let mut request = MediaPayload {
                    path: path.clone(),
                    ..Default::default()
                };
                match kind.as_str() {
                    "still" | "video" | "audio" => {
                        let identity = required_string(
                            payload,
                            "contentIdentity",
                            format!("{path}.contentIdentity"),
                        )?
                        .to_owned();
                        request.expected_sha256 =
                            identity.starts_with("sha256:").then_some(identity);
                        request.maximum_size = self.limits.max_footage_bytes;
                        if operation == MediaOperation::Materialize {
                            request.extension = media_extension(
                                required_string(payload, "extension", format!("{path}.extension"))?,
                                &kind,
                            )?;
                        }
                    }
                    "svg" | "psd" => {
                        let key = if kind == "svg" {
                            "contentIdentity"
                        } else {
                            "documentIdentity"
                        };
                        request.expected_identity = Some(
                            required_string(payload, key, format!("{path}.{key}"))?.to_owned(),
                        );
                        request.extension = format!(".{kind}");
                        request.maximum_size = if kind == "svg" {
                            self.limits.max_portable_bytes
                        } else {
                            self.limits.max_psd_bytes
                        };
                    }
                    _ => return Err(format!("{path}.kind is unsupported")),
                }
                items.push((
                    request,
                    required_mut(payload, "storage", format!("{path}.storage"))?,
                ));
            }
            for (request, storage) in items {
                match operation {
                    MediaOperation::Materialize => {
                        request.materialize(&bundle, storage, &mut budget)?
                    }
                    MediaOperation::Resolve => {
                        resolved.push(request.resolve(&bundle, storage, &mut budget)?)
                    }
                }
            }
        }
        Ok(resolved)
    }
}

#[cfg(test)]
use media_file::{Fnv64State, MediaFiles};
#[cfg(test)]
mod tests;

#[cfg(test)]
mod fixtures;

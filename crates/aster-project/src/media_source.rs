use crate::ProjectError;
use base64::Engine;
use serde::Deserialize;
mod digest;
use digest::MediaByteDigest;
#[cfg(test)]
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProjectMediaStorage {
    Inline {
        byte_identity: String,
        data: String,
    },
    Relative {
        relative_path: String,
        byte_identity: String,
        /// A persisted or bridge-provided hint never authorizes native filesystem access.
        #[serde(default)]
        resolved_path: Option<String>,
    },
    External {
        external_path: String,
        #[serde(default)]
        byte_identity: Option<String>,
    },
}

#[derive(Clone, Debug, clap::Args)]
pub struct MediaSourceLimits {
    #[arg(long, default_value_t = Self::default().project_media_source_bytes)]
    pub project_media_source_bytes: u64,
    #[arg(long, default_value_t = Self::default().project_media_inline_bytes)]
    pub project_media_inline_bytes: u64,
    #[arg(long, default_value_t = Self::default().project_media_total_bytes)]
    pub project_media_total_bytes: u64,
    #[arg(long, default_value_t = Self::default().project_media_files)]
    pub project_media_files: usize,
}

impl Default for MediaSourceLimits {
    fn default() -> Self {
        Self {
            project_media_source_bytes: 536_870_912,
            project_media_inline_bytes: 134_217_728,
            project_media_total_bytes: 2_147_483_648,
            project_media_files: 4096,
        }
    }
}

pub struct MediaSourceSnapshot {
    pub bytes: Vec<u8>,
    pub byte_length: u64,
    pub sha256: String,
    pub byte_identity: String,
    pub path: Option<PathBuf>,
}

/// Job-local read-only admission. Authored paths are resolved against one canonical bundle root.
pub struct MediaSourceReader {
    root: PathBuf,
    limits: MediaSourceLimits,
    admitted: BTreeMap<String, u64>,
    total_bytes: u64,
    inline_bytes: u64,
    files: usize,
}

impl MediaSourceReader {
    pub fn new(root: &Path, limits: MediaSourceLimits) -> Result<Self, ProjectError> {
        if limits.project_media_source_bytes == 0
            || limits.project_media_source_bytes == u64::MAX
            || limits.project_media_inline_bytes == 0
            || limits.project_media_total_bytes == 0
            || limits.project_media_files == 0
        {
            return Err(ProjectError::InvalidMedia(
                "positive bounded media limits required",
            ));
        }
        let root = root.canonicalize()?;
        if !root.is_dir() {
            return Err(ProjectError::InvalidMedia(
                "media bundle root must be a directory",
            ));
        }
        Ok(Self {
            root,
            limits,
            admitted: BTreeMap::new(),
            total_bytes: 0,
            inline_bytes: 0,
            files: 0,
        })
    }

    pub fn read(
        &mut self,
        storage: &ProjectMediaStorage,
        content_identity: Option<&str>,
        max_bytes: u64,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        self.read_retained(storage, content_identity, max_bytes, true)
    }

    /// Authenticate a file in bounded chunks without retaining its encoded bytes.
    pub fn inspect(
        &mut self,
        storage: &ProjectMediaStorage,
        content_identity: Option<&str>,
        max_bytes: u64,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        self.read_retained(storage, content_identity, max_bytes, false)
    }

    pub(crate) fn read_retained(
        &mut self,
        storage: &ProjectMediaStorage,
        content_identity: Option<&str>,
        max_bytes: u64,
        retain_file_bytes: bool,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        if max_bytes == 0 || self.files >= self.limits.project_media_files {
            return Err(ProjectError::InvalidMedia(
                "media file admission limit exceeded",
            ));
        }
        let maximum = max_bytes.min(self.limits.project_media_source_bytes);
        let (bytes, path, declared) = match storage {
            ProjectMediaStorage::Inline {
                byte_identity,
                data,
            } => {
                let declared = Self::identity_length(byte_identity)?;
                if declared
                    > maximum.min(
                        self.limits
                            .project_media_inline_bytes
                            .saturating_sub(self.inline_bytes),
                    )
                    || declared.div_ceil(3).checked_mul(4) != Some(data.len() as u64)
                {
                    return Err(ProjectError::InvalidMedia(
                        "inline payload exceeds declared byte budget",
                    ));
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(data)
                    .map_err(|_| ProjectError::InvalidMedia("inline payload is not base64"))?;
                (bytes, None, byte_identity.as_str())
            }
            ProjectMediaStorage::Relative {
                relative_path,
                byte_identity,
                ..
            } => {
                let resolved = self.resolve(relative_path)?;
                return self.read_file(
                    resolved,
                    maximum,
                    Some(byte_identity),
                    content_identity,
                    retain_file_bytes,
                );
            }
            ProjectMediaStorage::External { .. } => {
                return Err(ProjectError::InvalidMedia(
                    "external payload must be saved into the bundle",
                ));
            }
        };
        let snapshot = Self::authenticate(bytes, path, Some(declared), content_identity)?;
        let inline_bytes = if snapshot.path.is_none() {
            snapshot.byte_length
        } else {
            0
        };
        let snapshot = self.admit(snapshot)?;
        self.inline_bytes += inline_bytes;
        Ok(snapshot)
    }

    /// Older saved footage may reference a bundle file without a media-import sidecar entry.
    pub fn read_relative_source(
        &mut self,
        relative_path: &str,
        content_identity: &str,
        max_bytes: u64,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        self.read_relative_retained(relative_path, content_identity, max_bytes, true)
    }

    pub(crate) fn read_relative_retained(
        &mut self,
        relative_path: &str,
        content_identity: &str,
        max_bytes: u64,
        retain_file_bytes: bool,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        if max_bytes == 0 || self.files >= self.limits.project_media_files {
            return Err(ProjectError::InvalidMedia(
                "media file admission limit exceeded",
            ));
        }
        let resolved = self.resolve(relative_path)?;
        self.read_file(
            resolved,
            max_bytes.min(self.limits.project_media_source_bytes),
            None,
            Some(content_identity),
            retain_file_bytes,
        )
    }

    fn resolve(&self, relative: &str) -> Result<PathBuf, ProjectError> {
        if relative.is_empty()
            || relative.len() > 4096
            || relative.contains(['\\', ':'])
            || relative
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || Path::new(relative)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err(ProjectError::InvalidMedia(
                "relative media path must stay within the bundle",
            ));
        }
        let resolved = self.root.join(relative).canonicalize()?;
        if !resolved.starts_with(&self.root) {
            return Err(ProjectError::InvalidMedia(
                "media path resolves outside the bundle",
            ));
        }
        Ok(resolved)
    }

    fn read_file(
        &mut self,
        path: PathBuf,
        maximum: u64,
        declared: Option<&str>,
        content_identity: Option<&str>,
        retain_bytes: bool,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        let mut file = File::open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > maximum {
            return Err(ProjectError::InvalidMedia(
                "media file exceeds source byte budget",
            ));
        }
        let mut bytes = Vec::new();
        let mut digest = MediaByteDigest::new();
        let mut buffer = [0_u8; 65536];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count])?;
            if digest.length > maximum {
                return Err(ProjectError::InvalidMedia(
                    "media file grew beyond source byte budget",
                ));
            }
            if retain_bytes {
                bytes.extend_from_slice(&buffer[..count]);
            }
        }
        let snapshot = digest.finish(bytes, Some(path), declared, content_identity)?;
        self.admit(snapshot)
    }

    fn identity_length(identity: &str) -> Result<u64, ProjectError> {
        let mut parts = identity.split(':');
        if parts.next() != Some("fnv64")
            || !parts.next().is_some_and(|s| {
                s.len() == 16
                    && s.bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            })
        {
            return Err(ProjectError::InvalidMedia(
                "portable byte identity is invalid",
            ));
        }
        let length = parts
            .next()
            .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|s| s.parse().ok())
            .ok_or(ProjectError::InvalidMedia(
                "portable byte length is invalid",
            ))?;
        if parts.next().is_some() {
            return Err(ProjectError::InvalidMedia(
                "portable byte identity has trailing fields",
            ));
        }
        Ok(length)
    }

    fn authenticate(
        bytes: Vec<u8>,
        path: Option<PathBuf>,
        byte_identity: Option<&str>,
        content_identity: Option<&str>,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        let mut digest = MediaByteDigest::new();
        digest.update(&bytes)?;
        digest.finish(bytes, path, byte_identity, content_identity)
    }

    fn admit(
        &mut self,
        snapshot: MediaSourceSnapshot,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        let additional = if self.admitted.contains_key(&snapshot.sha256) {
            0
        } else {
            snapshot.byte_length
        };
        let total = self
            .total_bytes
            .checked_add(additional)
            .filter(|total| *total <= self.limits.project_media_total_bytes)
            .ok_or(ProjectError::InvalidMedia(
                "aggregate media byte budget exceeded",
            ))?;
        self.admitted
            .insert(snapshot.sha256.clone(), snapshot.byte_length);
        self.total_bytes = total;
        self.files += 1;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests;

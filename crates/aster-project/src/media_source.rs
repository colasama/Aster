use crate::ProjectError;
use base64::Engine;
use serde::Deserialize;
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
                let bytes = Self::read_file(&resolved, maximum)?;
                (bytes, Some(resolved), byte_identity.as_str())
            }
            ProjectMediaStorage::External { .. } => {
                return Err(ProjectError::InvalidMedia(
                    "external payload must be saved into the bundle",
                ));
            }
        };
        let snapshot = Self::authenticate(bytes, path, Some(declared), content_identity)?;
        let inline_bytes = if snapshot.path.is_none() {
            snapshot.bytes.len() as u64
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
        if max_bytes == 0 || self.files >= self.limits.project_media_files {
            return Err(ProjectError::InvalidMedia(
                "media file admission limit exceeded",
            ));
        }
        let resolved = self.resolve(relative_path)?;
        let bytes = Self::read_file(
            &resolved,
            max_bytes.min(self.limits.project_media_source_bytes),
        )?;
        let snapshot = Self::authenticate(bytes, Some(resolved), None, Some(content_identity))?;
        self.admit(snapshot)
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

    fn read_file(path: &Path, maximum: u64) -> Result<Vec<u8>, ProjectError> {
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > maximum {
            return Err(ProjectError::InvalidMedia(
                "media file exceeds source byte budget",
            ));
        }
        let mut bytes = Vec::new();
        file.take(maximum + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > maximum {
            return Err(ProjectError::InvalidMedia(
                "media file grew beyond source byte budget",
            ));
        }
        Ok(bytes)
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
        let sha256 = format!("{:x}", Sha256::digest(&bytes));
        let (mut left, mut right) = (0x811c9dc5_u32, 0x9e3779b9_u32);
        for byte in &bytes {
            left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        let identity = format!("fnv64:{left:08x}{right:08x}:{}", bytes.len());
        if byte_identity.is_some_and(|expected| expected != identity)
            || content_identity.is_some_and(|expected| {
                expected != identity && expected != format!("sha256:{sha256}")
            })
        {
            return Err(ProjectError::InvalidMedia("media content identity differs"));
        }
        Ok(MediaSourceSnapshot {
            bytes,
            sha256,
            byte_identity: identity,
            path,
        })
    }

    fn admit(
        &mut self,
        snapshot: MediaSourceSnapshot,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        let additional = if self.admitted.contains_key(&snapshot.sha256) {
            0
        } else {
            snapshot.bytes.len() as u64
        };
        let total = self
            .total_bytes
            .checked_add(additional)
            .filter(|total| *total <= self.limits.project_media_total_bytes)
            .ok_or(ProjectError::InvalidMedia(
                "aggregate media byte budget exceeded",
            ))?;
        self.admitted
            .insert(snapshot.sha256.clone(), snapshot.bytes.len() as u64);
        self.total_bytes = total;
        self.files += 1;
        Ok(snapshot)
    }
}

#[cfg(test)]
mod tests;

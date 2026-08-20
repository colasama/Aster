//! Bounded registry index parsing and deterministic compatible-release selection.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::Capability;

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub const MAX_REGISTRY_BYTES: usize = 1024 * 1024;
pub const MAX_REGISTRY_PACKAGES: usize = 1024;
pub const MAX_RELEASES_PER_PACKAGE: usize = 64;
pub const MAX_PLUGIN_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryIndex {
    pub schema_version: u32,
    pub packages: Vec<RegistryPackage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryPackage {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub author: String,
    pub releases: Vec<RegistryRelease>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegistryRelease {
    pub version: String,
    pub api_version: u32,
    pub download_url: String,
    pub sha256: String,
    pub archive_bytes: u64,
    #[serde(default)]
    pub capabilities: BTreeSet<Capability>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryDownloadPlan {
    pub plugin_id: String,
    pub version: String,
    pub download_url: String,
    pub expected_sha256: String,
    pub max_archive_bytes: u64,
}

impl RegistryIndex {
    pub fn parse(bytes: &[u8]) -> Result<Self, RegistryError> {
        if bytes.len() > MAX_REGISTRY_BYTES {
            return Err(RegistryError::IndexTooLarge(bytes.len()));
        }
        let index: Self = serde_json::from_slice(bytes)?;
        index.validate()?;
        Ok(index)
    }

    pub fn validate(&self) -> Result<(), RegistryError> {
        if self.schema_version != REGISTRY_SCHEMA_VERSION {
            return Err(RegistryError::UnsupportedSchema(self.schema_version));
        }
        if self.packages.len() > MAX_REGISTRY_PACKAGES {
            return Err(RegistryError::TooManyPackages(self.packages.len()));
        }
        let mut package_ids = BTreeSet::new();
        for package in &self.packages {
            package.validate()?;
            if !package_ids.insert(package.id.as_str()) {
                return Err(RegistryError::DuplicatePackage(package.id.clone()));
            }
        }
        Ok(())
    }

    pub fn compatible_download(
        &self,
        plugin_id: &str,
        api_version: u32,
    ) -> Result<RegistryDownloadPlan, RegistryError> {
        let package = self
            .packages
            .iter()
            .find(|package| package.id == plugin_id)
            .ok_or_else(|| RegistryError::MissingPackage(plugin_id.to_owned()))?;
        let release = package
            .releases
            .iter()
            .filter(|release| release.api_version == api_version)
            .max_by_key(|release| parse_version(&release.version).unwrap_or_default())
            .ok_or_else(|| RegistryError::NoCompatibleRelease {
                plugin: plugin_id.to_owned(),
                api_version,
            })?;
        Ok(RegistryDownloadPlan {
            plugin_id: package.id.clone(),
            version: release.version.clone(),
            download_url: release.download_url.clone(),
            expected_sha256: release.sha256.clone(),
            max_archive_bytes: release.archive_bytes,
        })
    }
}

impl RegistryPackage {
    fn validate(&self) -> Result<(), RegistryError> {
        if !valid_id(&self.id) {
            return Err(RegistryError::InvalidPackageId(self.id.clone()));
        }
        for (field, value) in [
            ("name", self.name.as_str()),
            ("summary", self.summary.as_str()),
            ("author", self.author.as_str()),
        ] {
            if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
                return Err(RegistryError::InvalidText(field));
            }
        }
        if self.releases.is_empty() || self.releases.len() > MAX_RELEASES_PER_PACKAGE {
            return Err(RegistryError::InvalidReleaseCount {
                plugin: self.id.clone(),
                count: self.releases.len(),
            });
        }
        let mut versions = BTreeSet::new();
        for release in &self.releases {
            release.validate()?;
            if !versions.insert(release.version.as_str()) {
                return Err(RegistryError::DuplicateRelease {
                    plugin: self.id.clone(),
                    version: release.version.clone(),
                });
            }
        }
        Ok(())
    }
}

impl RegistryRelease {
    fn validate(&self) -> Result<(), RegistryError> {
        if parse_version(&self.version).is_none() {
            return Err(RegistryError::InvalidVersion(self.version.clone()));
        }
        if self.api_version == 0 {
            return Err(RegistryError::InvalidApiVersion);
        }
        if !valid_https_url(&self.download_url) {
            return Err(RegistryError::UnsafeDownloadUrl(self.download_url.clone()));
        }
        if self.sha256.len() != 64
            || !self
                .sha256
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err(RegistryError::InvalidSha256);
        }
        if self.archive_bytes == 0 || self.archive_bytes > MAX_PLUGIN_ARCHIVE_BYTES {
            return Err(RegistryError::InvalidArchiveSize(self.archive_bytes));
        }
        Ok(())
    }
}

fn parse_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    parts.next().is_none().then_some(parsed)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id.split('.').count() >= 2
        && id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || ".-_".contains(character)
        })
}

fn valid_https_url(value: &str) -> bool {
    value.starts_with("https://")
        && value.len() <= 2048
        && !value.contains(['\\', '@'])
        && !value.chars().any(char::is_whitespace)
}

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("plugin registry index is invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("plugin registry index is {0} bytes; the limit is 1 MiB")]
    IndexTooLarge(usize),
    #[error("plugin registry schema {0} is unsupported")]
    UnsupportedSchema(u32),
    #[error("plugin registry contains {0} packages; the limit is 1024")]
    TooManyPackages(usize),
    #[error("plugin registry repeats package `{0}`")]
    DuplicatePackage(String),
    #[error("plugin registry package id `{0}` is invalid")]
    InvalidPackageId(String),
    #[error("plugin registry {0} is empty, oversized, or contains control characters")]
    InvalidText(&'static str),
    #[error("plugin `{plugin}` contains {count} releases; expected 1 through 64")]
    InvalidReleaseCount { plugin: String, count: usize },
    #[error("plugin `{plugin}` repeats release `{version}`")]
    DuplicateRelease { plugin: String, version: String },
    #[error("plugin registry version `{0}` is not numeric major.minor.patch")]
    InvalidVersion(String),
    #[error("plugin registry API version must be nonzero")]
    InvalidApiVersion,
    #[error("plugin registry download URL `{0}` must be bounded HTTPS without credentials")]
    UnsafeDownloadUrl(String),
    #[error("plugin registry release SHA-256 is invalid")]
    InvalidSha256,
    #[error("plugin archive declares {0} bytes; expected 1 through 64 MiB")]
    InvalidArchiveSize(u64),
    #[error("plugin registry has no package `{0}`")]
    MissingPackage(String),
    #[error("plugin `{plugin}` has no release for API {api_version}")]
    NoCompatibleRelease { plugin: String, api_version: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIGEST: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn index_json(releases: &str) -> Vec<u8> {
        format!(
            r#"{{"schema_version":1,"packages":[{{"id":"org.aster.tint","name":"Tint","summary":"GPU tint","author":"Aster","releases":[{releases}]}}]}}"#
        )
        .into_bytes()
    }

    fn release(version: &str, api: u32, url: &str) -> String {
        format!(
            r#"{{"version":"{version}","api_version":{api},"download_url":"{url}","sha256":"{DIGEST}","archive_bytes":4096,"capabilities":["gpu_render"]}}"#
        )
    }

    #[test]
    fn chooses_the_latest_exact_api_release_deterministically() {
        let bytes = index_json(&format!(
            "{},{},{}",
            release("1.2.0", 1, "https://plugins.aster.example/tint-1.2.0.zip"),
            release("1.10.0", 1, "https://plugins.aster.example/tint-1.10.0.zip"),
            release("2.0.0", 2, "https://plugins.aster.example/tint-2.0.0.zip"),
        ));
        let index = RegistryIndex::parse(&bytes).unwrap();
        let plan = index.compatible_download("org.aster.tint", 1).unwrap();
        assert_eq!(plan.version, "1.10.0");
        assert_eq!(plan.max_archive_bytes, 4096);
        assert_eq!(plan.expected_sha256, DIGEST);
    }

    #[test]
    fn rejects_insecure_urls_bad_digests_and_duplicate_releases() {
        let insecure = index_json(&release("1.0.0", 1, "http://plugins.example/tint.zip"));
        assert!(matches!(
            RegistryIndex::parse(&insecure),
            Err(RegistryError::UnsafeDownloadUrl(_))
        ));
        let bad_digest = index_json(
            &release("1.0.0", 1, "https://plugins.example/tint.zip").replace(DIGEST, "abcd"),
        );
        assert!(matches!(
            RegistryIndex::parse(&bad_digest),
            Err(RegistryError::InvalidSha256)
        ));
        let candidate = release("1.0.0", 1, "https://plugins.example/tint.zip");
        let duplicate = index_json(&format!("{candidate},{candidate}"));
        assert!(matches!(
            RegistryIndex::parse(&duplicate),
            Err(RegistryError::DuplicateRelease { .. })
        ));
    }

    #[test]
    fn refuses_oversized_indexes_before_parsing() {
        let bytes = vec![b' '; MAX_REGISTRY_BYTES + 1];
        assert!(matches!(
            RegistryIndex::parse(&bytes),
            Err(RegistryError::IndexTooLarge(_))
        ));
    }
}

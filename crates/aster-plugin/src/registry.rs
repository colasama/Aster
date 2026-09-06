//! Bounded registry index parsing and deterministic compatible-release selection.

use std::{collections::BTreeSet, net::IpAddr};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{Capability, PluginMetadata};

#[derive(Clone, Debug, clap::Args)]
pub struct RegistryLimits {
    #[arg(long, default_value_t = Self::default().max_registry_bytes)]
    pub max_registry_bytes: usize,
    #[arg(long, default_value_t = Self::default().max_registry_packages)]
    pub max_registry_packages: usize,
    #[arg(long, default_value_t = Self::default().max_releases_per_package)]
    pub max_releases_per_package: usize,
    #[arg(long, default_value_t = Self::default().max_plugin_archive_bytes)]
    pub max_plugin_archive_bytes: u64,
}
impl Default for RegistryLimits {
    fn default() -> Self {
        Self {
            max_registry_bytes: 1024 * 1024,
            max_registry_packages: 1024,
            max_releases_per_package: 64,
            max_plugin_archive_bytes: 64 * 1024 * 1024,
        }
    }
}

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

impl RegistryLimits {
    pub fn parse(&self, bytes: &[u8]) -> Result<RegistryIndex, RegistryError> {
        if bytes.len() > self.max_registry_bytes {
            return Err(RegistryError::IndexTooLarge(bytes.len()));
        }
        let index: RegistryIndex = serde_json::from_slice(bytes)?;
        index.validate(self)?;
        Ok(index)
    }
}

impl RegistryIndex {
    pub const SCHEMA_VERSION: u32 = 1;
    pub fn validate(&self, limits: &RegistryLimits) -> Result<(), RegistryError> {
        if self.schema_version != Self::SCHEMA_VERSION {
            return Err(RegistryError::UnsupportedSchema(self.schema_version));
        }
        if self.packages.len() > limits.max_registry_packages {
            return Err(RegistryError::TooManyPackages(self.packages.len()));
        }
        let mut package_ids = BTreeSet::new();
        for package in &self.packages {
            package.validate(limits)?;
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
        limits: &RegistryLimits,
    ) -> Result<RegistryDownloadPlan, RegistryError> {
        self.validate(limits)?;
        let package = self
            .packages
            .iter()
            .find(|package| package.id == plugin_id)
            .ok_or_else(|| RegistryError::MissingPackage(plugin_id.to_owned()))?;
        let release = package
            .releases
            .iter()
            .filter(|release| release.api_version == api_version)
            .filter_map(|release| release.numeric_version().map(|version| (version, release)))
            .max_by_key(|(version, _)| *version)
            .map(|(_, release)| release)
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
    fn validate(&self, limits: &RegistryLimits) -> Result<(), RegistryError> {
        if !PluginMetadata::valid_plugin_id(&self.id) {
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
        if self.releases.is_empty() || self.releases.len() > limits.max_releases_per_package {
            return Err(RegistryError::InvalidReleaseCount {
                plugin: self.id.clone(),
                count: self.releases.len(),
            });
        }
        let mut versions = BTreeSet::new();
        for release in &self.releases {
            release.validate(limits)?;
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
    fn validate(&self, limits: &RegistryLimits) -> Result<(), RegistryError> {
        if self.numeric_version().is_none() {
            return Err(RegistryError::InvalidVersion(self.version.clone()));
        }
        if self.api_version == 0 {
            return Err(RegistryError::InvalidApiVersion);
        }
        if !Self::valid_https_url(&self.download_url) {
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
        if self.archive_bytes == 0 || self.archive_bytes > limits.max_plugin_archive_bytes {
            return Err(RegistryError::InvalidArchiveSize(self.archive_bytes));
        }
        Ok(())
    }
}

impl RegistryRelease {
    pub fn numeric_version(&self) -> Option<(u64, u64, u64)> {
        let mut parts = self.version.split('.');
        if !self
            .version
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        {
            return None;
        }
        let parsed = (
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        );
        parts.next().is_none().then_some(parsed)
    }

    fn valid_https_url(value: &str) -> bool {
        if value.len() > 2048
            || value.contains('\\')
            || value
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return false;
        }
        let Some(remainder) = value.strip_prefix("https://") else {
            return false;
        };
        let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.is_empty() || authority.contains('@') {
            return false;
        }
        let Some(host) = Self::authority_host(authority) else {
            return false;
        };
        if let Ok(address) = host.parse::<IpAddr>() {
            return Self::public_ip_literal(address);
        }
        let host = host.to_ascii_lowercase();
        // Numeric final labels are interpreted as IPv4 by browser URL parsers.
        let last = host.rsplit('.').next().unwrap_or_default();
        let numeric = last.bytes().all(|byte| byte.is_ascii_digit())
            || last.strip_prefix("0x").is_some_and(|digits| {
                !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_hexdigit())
            });
        !numeric
            && host != "localhost"
            && !host.ends_with(".localhost")
            && !host.ends_with(".local")
            && host.len() <= 253
            && host.split('.').count() >= 2
            && host.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && label
                        .as_bytes()
                        .first()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .as_bytes()
                        .last()
                        .is_some_and(u8::is_ascii_alphanumeric)
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
    }

    fn authority_host(authority: &str) -> Option<&str> {
        if let Some(bracketed) = authority.strip_prefix('[') {
            let closing = bracketed.find(']')?;
            let host = &bracketed[..closing];
            let suffix = &bracketed[closing + 1..];
            let valid_port = suffix.is_empty()
                || suffix
                    .strip_prefix(':')
                    .is_some_and(|port| port.parse::<u16>().is_ok_and(|value| value != 0));
            return (host.parse::<std::net::Ipv6Addr>().is_ok() && valid_port).then_some(host);
        }
        match authority.rsplit_once(':') {
            Some((host, port))
                if !host.contains(':') && port.parse::<u16>().is_ok_and(|value| value != 0) =>
            {
                Some(host)
            }
            Some(_) => None,
            None => Some(authority),
        }
    }

    fn public_ip_literal(address: IpAddr) -> bool {
        match address {
            IpAddr::V4(address) => {
                !(address.is_private()
                    || address.is_loopback()
                    || address.is_link_local()
                    || address.is_broadcast()
                    || address.is_documentation()
                    || address.is_unspecified()
                    || address.is_multicast())
            }
            IpAddr::V6(address) => {
                if let Some(mapped) = address.to_ipv4_mapped() {
                    return Self::public_ip_literal(IpAddr::V4(mapped));
                }
                let first = address.segments()[0];
                !(address.is_loopback()
                    || address.is_unspecified()
                    || address.is_multicast()
                    || first & 0xfe00 == 0xfc00
                    || first & 0xffc0 == 0xfe80)
            }
        }
    }
}

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("plugin registry index is invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("plugin registry index is {0} bytes; it exceeds the configured limit")]
    IndexTooLarge(usize),
    #[error("plugin registry schema {0} is unsupported")]
    UnsupportedSchema(u32),
    #[error("plugin registry contains {0} packages; it exceeds the configured limit")]
    TooManyPackages(usize),
    #[error("plugin registry repeats package `{0}`")]
    DuplicatePackage(String),
    #[error("plugin registry package id `{0}` is invalid")]
    InvalidPackageId(String),
    #[error("plugin registry {0} is empty, oversized, or contains control characters")]
    InvalidText(&'static str),
    #[error(
        "plugin `{plugin}` contains {count} releases; expected a nonempty list within the configured limit"
    )]
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
    #[error(
        "plugin archive declares {0} bytes; expected a nonzero size within the configured limit"
    )]
    InvalidArchiveSize(u64),
    #[error("plugin registry has no package `{0}`")]
    MissingPackage(String),
    #[error("plugin `{plugin}` has no release for API {api_version}")]
    NoCompatibleRelease { plugin: String, api_version: u32 },
}

#[cfg(test)]
mod tests;

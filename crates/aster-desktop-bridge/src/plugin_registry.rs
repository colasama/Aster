//! Read-only catalog projection for Aster's built-in development registry fixture.

use aster_plugin::{
    Capability,
    registry::{RegistryIndex, RegistryLimits, RegistryPackage},
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginRegistryCatalog {
    source: &'static str,
    development_fixture: bool,
    host_api_version: u32,
    packages: Vec<PluginRegistryEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginRegistryEntry {
    id: String,
    name: String,
    summary: String,
    author: String,
    latest_version: String,
    api_version: u32,
    compatible: bool,
    compatible_version: Option<String>,
    capabilities: Vec<Capability>,
}

impl PluginRegistryCatalog {
    pub(crate) const DEVELOPMENT_INDEX: &[u8] =
        include_bytes!("../../../src/core/plugin-registry.development.json");

    pub(crate) fn from_bytes(
        bytes: &[u8],
        host_api_version: u32,
        limits: &RegistryLimits,
    ) -> Result<PluginRegistryCatalog, String> {
        let index = limits.parse(bytes).map_err(|error| error.to_string())?;
        let packages = index
            .packages
            .iter()
            .map(|package| {
                PluginRegistryEntry::from_package(&index, package, host_api_version, limits)
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(PluginRegistryCatalog {
            source: "Built-in development fixture",
            development_fixture: true,
            host_api_version,
            packages,
        })
    }
}

impl PluginRegistryEntry {
    fn from_package(
        index: &RegistryIndex,
        package: &RegistryPackage,
        host_api_version: u32,
        limits: &RegistryLimits,
    ) -> Result<PluginRegistryEntry, String> {
        let latest = package
            .releases
            .iter()
            .max_by_key(|release| release.numeric_version())
            .ok_or_else(|| format!("registry package {} has no releases", package.id))?;
        let compatible = index
            .compatible_download(&package.id, host_api_version, limits)
            .ok()
            .and_then(|plan| {
                package
                    .releases
                    .iter()
                    .find(|release| release.version == plan.version)
            });
        let displayed = compatible.unwrap_or(latest);
        Ok(PluginRegistryEntry {
            id: package.id.clone(),
            name: package.name.clone(),
            summary: package.summary.clone(),
            author: package.author.clone(),
            latest_version: latest.version.clone(),
            api_version: displayed.api_version,
            compatible: compatible.is_some(),
            compatible_version: compatible.map(|release| release.version.clone()),
            capabilities: displayed.capabilities.iter().copied().collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_is_bounded_and_selects_exact_host_api_versions()
    -> Result<(), Box<dyn std::error::Error>> {
        let catalog = PluginRegistryCatalog::from_bytes(
            PluginRegistryCatalog::DEVELOPMENT_INDEX,
            1,
            &RegistryLimits::default(),
        )?;
        assert!(catalog.development_fixture);
        assert_eq!(catalog.host_api_version, 1);
        assert_eq!(catalog.packages.len(), 3);
        let tint = &catalog.packages[0];
        assert_eq!(tint.latest_version, "2.0.0");
        assert_eq!(tint.compatible_version.as_deref(), Some("1.1.0"));
        assert!(tint.compatible);
        let future = &catalog.packages[2];
        assert!(!future.compatible);
        assert_eq!(future.compatible_version, None);
        assert_eq!(future.api_version, 2);
        Ok(())
    }

    #[test]
    fn fixture_artifacts_use_only_the_reserved_non_routable_domain()
    -> Result<(), Box<dyn std::error::Error>> {
        let index = RegistryLimits::default().parse(PluginRegistryCatalog::DEVELOPMENT_INDEX)?;
        for release in index.packages.iter().flat_map(|package| &package.releases) {
            assert!(
                release
                    .download_url
                    .starts_with("https://registry.invalid/development/"),
                "development artifacts must never imply a public install source"
            );
        }
        Ok(())
    }

    #[test]
    fn catalog_projection_never_exposes_artifact_locations_or_digests()
    -> Result<(), Box<dyn std::error::Error>> {
        let catalog = PluginRegistryCatalog::from_bytes(
            PluginRegistryCatalog::DEVELOPMENT_INDEX,
            1,
            &RegistryLimits::default(),
        )?;
        let json = serde_json::to_string(&catalog)?;
        assert!(!json.contains("registry.invalid"));
        assert!(!json.contains("download"));
        assert!(!json.contains("sha256"));
        assert!(!json.contains("archive"));
        Ok(())
    }

    #[test]
    fn malformed_or_oversized_indexes_are_rejected_before_projection() {
        assert!(
            PluginRegistryCatalog::from_bytes(b"{not-json}", 1, &RegistryLimits::default())
                .is_err()
        );
        let oversized = vec![b' '; RegistryLimits::default().max_registry_bytes + 1];
        assert!(
            PluginRegistryCatalog::from_bytes(&oversized, 1, &RegistryLimits::default()).is_err()
        );
    }

    #[test]
    fn future_host_selects_future_release_without_network_access()
    -> Result<(), Box<dyn std::error::Error>> {
        let catalog = PluginRegistryCatalog::from_bytes(
            PluginRegistryCatalog::DEVELOPMENT_INDEX,
            2,
            &RegistryLimits::default(),
        )?;
        assert_eq!(
            catalog.packages[0].compatible_version.as_deref(),
            Some("2.0.0")
        );
        assert!(catalog.packages[2].compatible);
        Ok(())
    }
}

//! Read-only catalog projection for Aster's built-in development registry fixture.

use aster_plugin::{
    Capability, HOST_PLUGIN_API_VERSION,
    registry::{RegistryIndex, RegistryPackage},
};
use serde::Serialize;

const DEVELOPMENT_INDEX: &[u8] = include_bytes!("../../src/core/plugin-registry.development.json");

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

#[tauri::command]
pub(crate) fn plugin_registry_catalog() -> Result<PluginRegistryCatalog, String> {
    catalog_from_bytes(DEVELOPMENT_INDEX, HOST_PLUGIN_API_VERSION)
}

fn catalog_from_bytes(
    bytes: &[u8],
    host_api_version: u32,
) -> Result<PluginRegistryCatalog, String> {
    let index = RegistryIndex::parse(bytes).map_err(|error| error.to_string())?;
    let packages = index
        .packages
        .iter()
        .map(|package| registry_entry(&index, package, host_api_version))
        .collect();
    Ok(PluginRegistryCatalog {
        source: "Built-in development fixture",
        development_fixture: true,
        host_api_version,
        packages,
    })
}

fn registry_entry(
    index: &RegistryIndex,
    package: &RegistryPackage,
    host_api_version: u32,
) -> PluginRegistryEntry {
    let latest = package
        .releases
        .iter()
        .max_by_key(|release| numeric_version(&release.version))
        .expect("validated registry packages always contain a release");
    let compatible = index
        .compatible_download(&package.id, host_api_version)
        .ok()
        .and_then(|plan| {
            package
                .releases
                .iter()
                .find(|release| release.version == plan.version)
        });
    let displayed = compatible.unwrap_or(latest);
    PluginRegistryEntry {
        id: package.id.clone(),
        name: package.name.clone(),
        summary: package.summary.clone(),
        author: package.author.clone(),
        latest_version: latest.version.clone(),
        api_version: displayed.api_version,
        compatible: compatible.is_some(),
        compatible_version: compatible.map(|release| release.version.clone()),
        capabilities: displayed.capabilities.iter().copied().collect(),
    }
}

fn numeric_version(version: &str) -> (u64, u64, u64) {
    let mut parts = version.split('.');
    (
        parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
        parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
        parts.next().and_then(|part| part.parse().ok()).unwrap_or(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_is_bounded_and_selects_exact_host_api_versions() {
        let catalog = catalog_from_bytes(DEVELOPMENT_INDEX, 1).expect("valid fixture");
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
    }

    #[test]
    fn fixture_artifacts_use_only_the_reserved_non_routable_domain() {
        let index = RegistryIndex::parse(DEVELOPMENT_INDEX).expect("valid fixture");
        for release in index.packages.iter().flat_map(|package| &package.releases) {
            assert!(
                release
                    .download_url
                    .starts_with("https://registry.invalid/development/"),
                "development artifacts must never imply a public install source"
            );
        }
    }

    #[test]
    fn catalog_projection_never_exposes_artifact_locations_or_digests() {
        let catalog = catalog_from_bytes(DEVELOPMENT_INDEX, 1).expect("valid fixture");
        let json = serde_json::to_string(&catalog).expect("serialize catalog");
        assert!(!json.contains("registry.invalid"));
        assert!(!json.contains("download"));
        assert!(!json.contains("sha256"));
        assert!(!json.contains("archive"));
    }

    #[test]
    fn malformed_or_oversized_indexes_are_rejected_before_projection() {
        assert!(catalog_from_bytes(b"{not-json}", 1).is_err());
        let oversized = vec![b' '; aster_plugin::registry::MAX_REGISTRY_BYTES + 1];
        assert!(catalog_from_bytes(&oversized, 1).is_err());
    }

    #[test]
    fn future_host_selects_future_release_without_network_access() {
        let catalog = catalog_from_bytes(DEVELOPMENT_INDEX, 2).expect("valid fixture");
        assert_eq!(
            catalog.packages[0].compatible_version.as_deref(),
            Some("2.0.0")
        );
        assert!(catalog.packages[2].compatible);
    }
}

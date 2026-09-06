use super::*;

impl RegistryRelease {
    fn fixture(version: &str, api_version: u32, url: &str) -> Self {
        Self {
            version: version.into(),
            api_version,
            download_url: url.into(),
            sha256: "0123456789abcdef".repeat(4),
            archive_bytes: 4096,
            capabilities: BTreeSet::from([Capability::GpuRender]),
        }
    }
}

impl RegistryIndex {
    fn fixture(releases: Vec<RegistryRelease>) -> Self {
        Self {
            schema_version: Self::SCHEMA_VERSION,
            packages: vec![RegistryPackage {
                id: "org.aster.tint".into(),
                name: "Tint".into(),
                summary: "GPU tint".into(),
                author: "Aster".into(),
                releases,
            }],
        }
    }
}

#[test]
fn chooses_the_latest_exact_api_release_deterministically() -> Result<(), Box<dyn std::error::Error>>
{
    let fixture = RegistryIndex::fixture(vec![
        RegistryRelease::fixture("1.2.0", 1, "https://plugins.example/tint-1.2.zip"),
        RegistryRelease::fixture("1.10.0", 1, "https://plugins.example/tint-1.10.zip"),
        RegistryRelease::fixture("2.0.0", 2, "https://plugins.example/tint-2.zip"),
    ]);
    let limits = RegistryLimits::default();
    let index = limits.parse(&serde_json::to_vec(&fixture)?)?;
    let plan = index.compatible_download("org.aster.tint", 1, &limits)?;
    assert_eq!(plan.version, "1.10.0");
    assert_eq!(plan.max_archive_bytes, 4096);
    assert_eq!(plan.expected_sha256, "0123456789abcdef".repeat(4));
    Ok(())
}

#[test]
fn rejects_unsafe_urls_and_invalid_download_plans() {
    let limits = RegistryLimits::default();
    for url in [
        "http://plugins.example/tint.zip",
        "https://",
        "https://localhost/tint.zip",
        "https://127.0.0.1/tint.zip",
        "https://10.0.0.1/tint.zip",
        "https://[::1]/tint.zip",
        "https://user@plugins.example/tint.zip",
        "https://[::ffff:127.0.0.1]/tint.zip",
        "https://127.1/tint.zip",
        "https://0x7f.0.0.1/tint.zip",
        "https://[plugins.example]/tint.zip",
        "https://plugins.example/\u{0}tint.zip",
    ] {
        let index = RegistryIndex::fixture(vec![RegistryRelease::fixture("1.0.0", 1, url)]);
        assert!(
            matches!(
                index.compatible_download("org.aster.tint", 1, &limits),
                Err(RegistryError::UnsafeDownloadUrl(_))
            ),
            "accepted {url:?}"
        );
    }
}

#[test]
fn rejects_bad_digests_duplicates_and_path_like_ids() {
    let limits = RegistryLimits::default();
    let release = RegistryRelease::fixture("1.0.0", 1, "https://plugins.example/tint.zip");
    let mut index = RegistryIndex::fixture(vec![release.clone(), release.clone()]);
    assert!(matches!(
        index.validate(&limits),
        Err(RegistryError::DuplicateRelease { .. })
    ));
    index.packages[0].releases.pop();
    index.packages[0].releases[0].sha256 = "abcd".into();
    assert!(matches!(
        index.validate(&limits),
        Err(RegistryError::InvalidSha256)
    ));
    index.packages[0].releases[0] = release;
    for id in [
        ".",
        "..",
        "org..tint",
        "org.-tint",
        "org.tint-",
        "org.tint_name",
    ] {
        index.packages[0].id = id.into();
        assert!(matches!(
            index.validate(&limits),
            Err(RegistryError::InvalidPackageId(_))
        ));
    }
}

#[test]
fn respects_configured_limits_before_publication() {
    let limits = RegistryLimits {
        max_registry_bytes: 8,
        max_plugin_archive_bytes: 4095,
        ..RegistryLimits::default()
    };
    assert!(matches!(
        limits.parse(&[b' '; 9]),
        Err(RegistryError::IndexTooLarge(9))
    ));
    let index = RegistryIndex::fixture(vec![RegistryRelease::fixture(
        "1.0.0",
        1,
        "https://plugins.example/tint.zip",
    )]);
    assert!(matches!(
        index.validate(&limits),
        Err(RegistryError::InvalidArchiveSize(4096))
    ));
}

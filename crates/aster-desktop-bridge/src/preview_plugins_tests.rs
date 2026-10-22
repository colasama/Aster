use super::*;
use aster_plugin::{PluginLimits, hot_reload::HotReloadController};
use std::{fs, path::PathBuf};

struct Fixture {
    root: PathBuf,
    host: PluginHost,
}

impl Fixture {
    fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let root =
            std::env::temp_dir().join(format!("aster-preview-plugins-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root)?;
        let fixture = Self {
            host: PluginHost {
                app_data: root.clone(),
                preference_limits: Default::default(),
                limits: PluginLimits::default(),
                snapshot_limits: PreviewPluginLimits::default(),
                runtime: HotReloadController::default(),
            },
            root,
        };
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/plugins/point-cloud")
            .canonicalize()?;
        aster_plugin::PluginRepository::at(fixture.root.join("plugins")).install(&source)?;
        Ok(fixture)
    }

    fn request() -> PreviewPluginRequest {
        PreviewPluginRequest {
            references: vec![PreviewGeneratorReference {
                plugin_id: "org.aster.example.point-cloud".into(),
                node_type: "point_cloud".into(),
            }],
        }
    }

    fn installed(&self, name: &str) -> PathBuf {
        self.root
            .join("plugins/org.aster.example.point-cloud")
            .join(name)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.parent() == Some(std::env::temp_dir().as_path())
            && self
                .root
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("aster-preview-plugins-"))
        {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

#[test]
fn frozen_runtime_round_trips_the_admitted_manifest_and_shaders()
-> Result<(), Box<dyn std::error::Error>> {
    let mut fixture = Fixture::new()?;
    let snapshot = fixture.host.prepare_preview_plugins(Fixture::request())?;
    assert!(snapshot.unavailable.is_empty());
    assert_eq!(snapshot.packages.len(), 1);
    let package = &snapshot.packages[0];
    let loaded = fixture
        .host
        .limits
        .load(fixture.installed("plugin.toml"), true)?;
    let manifest = fixture.host.limits.parse_manifest(&package.manifest_toml)?;
    assert_eq!(
        serde_json::to_value(manifest)?,
        serde_json::to_value(loaded.manifest)?
    );
    assert_eq!(package.shader_sources, loaded.shader_sources);
    let serialized = serde_json::to_value(snapshot)?;
    assert!(serialized["packages"][0]["manifestToml"].is_string());
    assert!(serialized["packages"][0]["shaderSources"].is_object());
    Ok(())
}

#[test]
fn snapshot_obeys_disabled_safe_mode_and_missing_node_policy()
-> Result<(), Box<dyn std::error::Error>> {
    let mut fixture = Fixture::new()?;
    fixture
        .host
        .set_plugin_enabled("org.aster.example.point-cloud".into(), false)?;
    let disabled = fixture.host.prepare_preview_plugins(Fixture::request())?;
    assert!(disabled.packages.is_empty());
    assert_eq!(disabled.unavailable[0].reason, UnavailableReason::Disabled);
    fixture.host.set_plugin_safe_mode(true)?;
    let safe = fixture.host.prepare_preview_plugins(Fixture::request())?;
    assert!(safe.packages.is_empty());
    assert_eq!(safe.unavailable[0].reason, UnavailableReason::SafeMode);
    fixture.host.set_plugin_safe_mode(false)?;
    fixture
        .host
        .set_plugin_enabled("org.aster.example.point-cloud".into(), true)?;
    let mut request = Fixture::request();
    request.references[0].node_type = "unknown_node".into();
    let missing = fixture.host.prepare_preview_plugins(request)?;
    assert!(missing.packages.is_empty());
    assert_eq!(missing.unavailable[0].reason, UnavailableReason::Missing);
    assert_eq!(
        fixture
            .host
            .prepare_preview_plugins(Fixture::request())?
            .packages
            .len(),
        1
    );
    Ok(())
}

#[test]
fn rejected_reload_freezes_the_previous_valid_manifest_and_shader_pair()
-> Result<(), Box<dyn std::error::Error>> {
    let mut fixture = Fixture::new()?;
    fixture.host.set_plugin_hot_reload(true)?;
    let first = fixture.host.prepare_preview_plugins(Fixture::request())?;
    let shader = fs::read_to_string(fixture.installed("compute.wgsl"))?;
    let manifest = fs::read_to_string(fixture.installed("plugin.toml"))?;
    fs::write(fixture.installed("compute.wgsl"), "not valid WGSL")?;
    fs::write(
        fixture.installed("plugin.toml"),
        manifest.replace("1.0.0", "2.0.0"),
    )?;
    let failed = fixture.host.status(true)?;
    assert!(failed.hot_reload.rejected_reloads > 0);
    let retained = fixture.host.prepare_preview_plugins(Fixture::request())?;
    assert_eq!(
        serde_json::to_value(&first)?,
        serde_json::to_value(&retained)?
    );
    fs::write(
        fixture.installed("compute.wgsl"),
        format!("{shader}\n// updated shader\n"),
    )?;
    fixture.host.status(true)?;
    let updated = fixture.host.prepare_preview_plugins(Fixture::request())?;
    assert!(updated.unavailable.is_empty());
    assert_ne!(
        first.packages[0].manifest_toml,
        updated.packages[0].manifest_toml
    );
    assert_ne!(
        first.packages[0].shader_sources,
        updated.packages[0].shader_sources
    );
    Ok(())
}

#[test]
fn invalid_first_runtime_is_explicitly_unavailable() -> Result<(), Box<dyn std::error::Error>> {
    let mut fixture = Fixture::new()?;
    fs::write(fixture.installed("compute.wgsl"), "not valid WGSL")?;
    let snapshot = fixture.host.prepare_preview_plugins(Fixture::request())?;
    assert!(snapshot.packages.is_empty());
    assert_eq!(snapshot.unavailable[0].reason, UnavailableReason::Missing);
    Ok(())
}

#[test]
fn snapshot_rejects_reserved_duplicate_and_over_budget_requests()
-> Result<(), Box<dyn std::error::Error>> {
    let mut fixture = Fixture::new()?;
    let mut duplicate = Fixture::request();
    duplicate.references.push(duplicate.references[0].clone());
    assert!(fixture.host.prepare_preview_plugins(duplicate).is_err());
    let mut reserved = Fixture::request();
    reserved.references[0].plugin_id = "org.aster.builtin.particles".into();
    assert!(fixture.host.prepare_preview_plugins(reserved).is_err());
    fixture
        .host
        .snapshot_limits
        .max_preview_plugin_snapshot_bytes = 1;
    assert!(
        fixture
            .host
            .prepare_preview_plugins(Fixture::request())
            .is_err()
    );
    fixture.host.limits.max_candidates = 0;
    assert!(
        fixture
            .host
            .prepare_preview_plugins(Fixture::request())
            .is_err()
    );
    Ok(())
}

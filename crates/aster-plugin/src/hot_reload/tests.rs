use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

use crate::tests::PluginFixture;

#[test]
fn debounces_changes_and_retains_the_last_valid_shader() -> Result<(), Box<dyn std::error::Error>> {
    let root = PluginFixture::temp_root("retain")?;
    PluginFixture::write_plugin(&root, "1.0.0", PluginFixture::EFFECT)?;
    let mut controller = HotReloadController::default();
    let start = Instant::now();
    let initial = controller.poll_at(&root, start)?;
    assert_eq!(initial.report.plugins[0].plugin.version, "1.0.0");

    PluginFixture::write_plugin(&root, "2.0.0", "this is not wgsl")?;
    let pending = controller.poll_at(&root, start + Duration::from_millis(10))?;
    assert!(pending.status.pending);
    assert_eq!(pending.report.plugins[0].plugin.version, "1.0.0");
    let rejected = controller.poll_at(&root, start + Duration::from_millis(400))?;
    assert!(!rejected.status.pending);
    assert_eq!(rejected.report.plugins[0].plugin.version, "1.0.0");
    assert_eq!(rejected.status.rejected_reloads, 1);
    assert_eq!(
        rejected.report.failures[0].manifest,
        Path::new("example/plugin.toml")
    );
    assert!(
        !rejected.report.failures[0]
            .message
            .contains(root.to_string_lossy().as_ref())
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn activates_a_valid_update_after_the_debounce_window() -> Result<(), Box<dyn std::error::Error>> {
    let root = PluginFixture::temp_root("activate")?;
    PluginFixture::write_plugin(&root, "1.0.0", PluginFixture::EFFECT)?;
    let mut controller = HotReloadController::default();
    let start = Instant::now();
    controller.poll_at(&root, start)?;
    PluginFixture::write_plugin(
        &root,
        "1.1.0",
        &format!("{}\n// changed", PluginFixture::EFFECT),
    )?;
    controller.poll_at(&root, start + Duration::from_millis(1))?;
    let updated = controller.poll_at(&root, start + Duration::from_millis(400))?;
    assert_eq!(updated.report.plugins[0].plugin.version, "1.1.0");
    assert_eq!(updated.status.successful_reloads, 2);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn rejects_the_host_reserved_namespace_during_hot_reload() -> Result<(), Box<dyn std::error::Error>>
{
    let root = PluginFixture::temp_root("reserved")?;
    PluginFixture::write_plugin(&root, "1.0.0", PluginFixture::EFFECT)?;
    let manifest_path = root.join("example/plugin.toml");
    let source = fs::read_to_string(&manifest_path)?
        .replace("com.example.reload", "org.aster.builtin.replacement");
    fs::write(manifest_path, source)?;

    let mut controller = HotReloadController::default();
    let view = controller.force_reload(&root)?;
    assert!(view.report.plugins.is_empty());
    assert_eq!(view.status.rejected_reloads, 1);
    assert!(view.report.failures[0].message.contains("host-reserved"));
    fs::remove_dir_all(root)?;
    Ok(())
}

impl PluginFixture {
    fn temp_root(name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aster-plugin-hot-reload-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root)?;
        Ok(root)
    }
}

impl PluginFixture {
    fn write_plugin(
        root: &Path,
        version: &str,
        shader: &str,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let plugin = root.join("example");
        fs::create_dir_all(&plugin)?;
        fs::write(
            plugin.join("plugin.toml"),
            format!(
                "[plugin]\nid = \"com.example.reload\"\nname = \"Reload\"\nversion = \"{version}\"\napi_version = 1\nshader = \"effect.wgsl\"\n"
            ),
        )?;
        fs::write(plugin.join("effect.wgsl"), shader)?;
        Ok(())
    }
}

#[test]
fn failed_scan_preserves_the_active_snapshot_and_can_be_retried()
-> Result<(), Box<dyn std::error::Error>> {
    let root = PluginFixture::temp_root("scan-failure")?;
    PluginFixture::write_plugin(&root, "1.0.0", PluginFixture::EFFECT)?;
    let mut controller = HotReloadController::default();
    let previous = controller.force_reload(&root)?;
    controller.plugin_limits.max_candidates = 0;
    assert!(controller.force_reload(&root).is_err());
    let retained = controller.view(true, false);
    assert_eq!(retained.report.plugins[0].plugin.version, "1.0.0");
    assert_eq!(
        retained.report.shader_sources,
        previous.report.shader_sources
    );
    assert_eq!(retained.status.revision, previous.status.revision);
    controller.plugin_limits.max_candidates = 256;
    PluginFixture::write_plugin(&root, "2.0.0", PluginFixture::EFFECT)?;
    assert_eq!(
        controller.force_reload(&root)?.report.plugins[0]
            .plugin
            .version,
        "2.0.0"
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn interrupted_installation_recovers_and_invalid_updates_preserve_the_old_package()
-> Result<(), Box<dyn std::error::Error>> {
    let root = PluginFixture::temp_root("install-recovery")?;
    PluginFixture::write_plugin(&root, "1.0.0", PluginFixture::EFFECT)?;
    let repository = crate::PluginRepository::at(root.join("installed"));
    repository.install(root.join("example"))?;
    fs::rename(
        repository.root.join("com.example.reload"),
        repository.root.join("com.example.reload.aster-backup"),
    )?;
    let recovered = repository.discover(|_| true)?;
    assert_eq!(recovered.plugins.len(), 1);
    assert_eq!(recovered.plugins[0].plugin.version, "1.0.0");
    assert!(
        !repository
            .root
            .join("com.example.reload.aster-backup")
            .exists()
    );
    PluginFixture::write_plugin(&root, "2.0.0", "invalid shader")?;
    assert!(repository.install(root.join("example")).is_err());
    let retained = repository.discover(|_| true)?;
    assert_eq!(retained.plugins[0].plugin.version, "1.0.0");
    assert_eq!(retained.shader_sources, recovered.shader_sources);
    fs::remove_dir_all(root)?;
    Ok(())
}

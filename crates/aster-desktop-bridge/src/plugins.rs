use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct PluginPreferences {
    #[serde(default)]
    pub(crate) schema_version: u32,
    pub(crate) safe_mode: bool,
    pub(crate) hot_reload_enabled: bool,
    pub(crate) disabled: BTreeSet<String>,
}

impl Default for PluginPreferences {
    fn default() -> Self {
        Self {
            schema_version: PluginPreferences::SCHEMA_VERSION,
            safe_mode: false,
            hot_reload_enabled: false,
            disabled: BTreeSet::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginStatus {
    pub(crate) directory: PathBuf,
    pub(crate) safe_mode: bool,
    pub(crate) disabled: BTreeSet<String>,
    pub(crate) report: aster_plugin::DiscoveryReport,
    pub(crate) hot_reload: aster_plugin::hot_reload::HotReloadStatus,
}

pub(crate) struct PluginHost {
    pub(crate) app_data: PathBuf,
    pub(crate) runtime: aster_plugin::hot_reload::HotReloadController,
}
impl PluginHost {
    pub(crate) fn status(&mut self, force_reload: bool) -> Result<PluginStatus, String> {
        let root = self.app_data.join("plugins");
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let preferences = PluginPreferences::read(&self.app_data)?;
        let runtime = &mut self.runtime;
        let (mut report, hot_reload) = if preferences.hot_reload_enabled && !preferences.safe_mode {
            let view = if force_reload {
                runtime.force_reload(&root)
            } else {
                runtime.poll(&root)
            }
            .map_err(|error| error.to_string())?;
            (view.report, view.status)
        } else {
            let report = aster_plugin::PluginRepository::at(&root)
                .discover(|_| false)
                .map_err(|error| error.to_string())?;
            let status = runtime
                .inactive_view(preferences.hot_reload_enabled, preferences.safe_mode)
                .status;
            (report, status)
        };
        report.shader_sources.clear();
        Ok(PluginStatus {
            directory: root.clone(),
            safe_mode: preferences.safe_mode,
            disabled: preferences.disabled,
            report: Self::redact_plugin_report(&root, report),
            hot_reload,
        })
    }

    pub(crate) fn load_plugin_runtime(
        &mut self,
        plugin_ids: BTreeSet<String>,
    ) -> Result<PluginStatus, String> {
        if plugin_ids.len() > 256 {
            return Err("too many plugin runtimes requested".to_owned());
        }
        let root = self.app_data.join("plugins");
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let preferences = PluginPreferences::read(&self.app_data)?;
        let requested = if preferences.safe_mode {
            BTreeSet::new()
        } else {
            plugin_ids
                .into_iter()
                .filter(|plugin_id| !preferences.disabled.contains(plugin_id))
                .collect()
        };
        let runtime = &mut self.runtime;
        let (mut report, hot_reload) = if preferences.hot_reload_enabled && !preferences.safe_mode {
            let view = runtime.poll(&root).map_err(|error| error.to_string())?;
            (view.report, view.status)
        } else {
            let report = aster_plugin::PluginRepository::at(&root)
                .discover(|id| requested.contains(id))
                .map_err(|error| error.to_string())?;
            let status = runtime
                .inactive_view(preferences.hot_reload_enabled, preferences.safe_mode)
                .status;
            (report, status)
        };
        report
            .shader_sources
            .retain(|plugin_id, _| requested.contains(plugin_id));
        Ok(PluginStatus {
            directory: root.clone(),
            safe_mode: preferences.safe_mode,
            disabled: preferences.disabled,
            report: Self::redact_plugin_report(&root, report),
            hot_reload,
        })
    }

    pub(crate) fn install_plugin(&mut self, source: String) -> Result<PluginStatus, String> {
        let root = self.app_data.join("plugins");
        aster_plugin::PluginRepository::at(root)
            .install(source)
            .map_err(|error| error.to_string())?;
        self.status(true)
    }

    pub(crate) fn set_plugin_enabled(
        &mut self,
        plugin_id: String,
        enabled: bool,
    ) -> Result<PluginStatus, String> {
        let root = self.app_data.join("plugins");
        let report = aster_plugin::PluginRepository::at(&root)
            .discover(|_| false)
            .map_err(|error| error.to_string())?;
        if !report
            .plugins
            .iter()
            .any(|manifest| manifest.plugin.id == plugin_id)
        {
            return Err(format!("plugin `{plugin_id}` is not installed"));
        }
        let mut preferences = PluginPreferences::read(&self.app_data)?;
        if enabled {
            preferences.disabled.remove(&plugin_id);
        } else {
            preferences.disabled.insert(plugin_id);
        }
        preferences.write(&self.app_data)?;
        self.status(false)
    }

    pub(crate) fn set_plugin_safe_mode(&mut self, safe_mode: bool) -> Result<PluginStatus, String> {
        let mut preferences = PluginPreferences::read(&self.app_data)?;
        preferences.safe_mode = safe_mode;
        preferences.write(&self.app_data)?;
        self.status(!safe_mode)
    }

    pub(crate) fn set_plugin_hot_reload(&mut self, enabled: bool) -> Result<PluginStatus, String> {
        let mut preferences = PluginPreferences::read(&self.app_data)?;
        preferences.hot_reload_enabled = enabled;
        preferences.write(&self.app_data)?;
        self.status(enabled && !preferences.safe_mode)
    }

    pub(crate) fn redact_plugin_report(
        root: &Path,
        mut report: aster_plugin::DiscoveryReport,
    ) -> aster_plugin::DiscoveryReport {
        let root_text = root.to_string_lossy();
        for failure in &mut report.failures {
            failure.manifest = failure
                .manifest
                .strip_prefix(root)
                .unwrap_or_else(|_| Path::new("plugin.toml"))
                .to_path_buf();
            failure.message = failure.message.replace(root_text.as_ref(), "<plugins>");
        }
        report
    }
}
impl PluginPreferences {
    const SCHEMA_VERSION: u32 = 1;
    pub(crate) fn read(app_data: &Path) -> Result<PluginPreferences, String> {
        let path = app_data.join("plugin-preferences.json");
        if !path.exists() {
            return Ok(PluginPreferences::default());
        }
        let source = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let mut preferences: Self =
            serde_json::from_str(&source).map_err(|error| error.to_string())?;
        if preferences.schema_version > Self::SCHEMA_VERSION {
            return Err(format!(
                "plugin preferences v{} are newer than this build",
                preferences.schema_version
            ));
        }
        let migrated = preferences.schema_version == 0;
        preferences.schema_version = Self::SCHEMA_VERSION;
        if migrated {
            preferences.write(app_data)?;
        }
        Ok(preferences)
    }

    pub(crate) fn write(&self, app_data: &Path) -> Result<(), String> {
        let path = app_data.join("plugin-preferences.json");
        let parent = path
            .parent()
            .ok_or_else(|| "plugin preferences path has no parent".to_owned())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        aster_project::AtomicFile::write(&path, |file| file.write_all(&bytes))
            .map_err(|error| error.to_string())
    }
}

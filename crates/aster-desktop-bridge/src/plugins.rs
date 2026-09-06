use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, clap::Args)]
pub(crate) struct PluginPreferenceLimits {
    #[arg(long, default_value_t = Self::default().max_plugin_preferences_bytes)]
    pub(crate) max_plugin_preferences_bytes: u64,
}
impl Default for PluginPreferenceLimits {
    fn default() -> Self {
        Self {
            max_plugin_preferences_bytes: 64 * 1024,
        }
    }
}

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
    pub(crate) preference_limits: PluginPreferenceLimits,
    pub(crate) limits: aster_plugin::PluginLimits,
    pub(crate) runtime: aster_plugin::hot_reload::HotReloadController,
}
impl PluginHost {
    fn repository(&self) -> aster_plugin::PluginRepository {
        aster_plugin::PluginRepository {
            root: self.app_data.join("plugins"),
            limits: self.limits.clone(),
        }
    }

    pub(crate) fn status(&mut self, force_reload: bool) -> Result<PluginStatus, String> {
        let root = self.app_data.join("plugins");
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let preferences = PluginPreferences::read(&self.app_data, &self.preference_limits)?;
        let repository = self.repository();
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
            let report = repository
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
        if plugin_ids.len() > self.limits.max_candidates {
            return Err("too many plugin runtimes requested".to_owned());
        }
        let root = self.app_data.join("plugins");
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let preferences = PluginPreferences::read(&self.app_data, &self.preference_limits)?;
        let requested = if preferences.safe_mode {
            BTreeSet::new()
        } else {
            plugin_ids
                .into_iter()
                .filter(|plugin_id| !preferences.disabled.contains(plugin_id))
                .collect()
        };
        let repository = self.repository();
        let runtime = &mut self.runtime;
        let (mut report, hot_reload) = if preferences.hot_reload_enabled && !preferences.safe_mode {
            let view = runtime.poll(&root).map_err(|error| error.to_string())?;
            (view.report, view.status)
        } else {
            let report = repository
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
        self.repository()
            .install(source)
            .map_err(|error| error.to_string())?;
        self.status(true)
    }

    pub(crate) fn set_plugin_enabled(
        &mut self,
        plugin_id: String,
        enabled: bool,
    ) -> Result<PluginStatus, String> {
        let report = self
            .repository()
            .discover(|_| false)
            .map_err(|error| error.to_string())?;
        if !report
            .plugins
            .iter()
            .any(|manifest| manifest.plugin.id == plugin_id)
        {
            return Err(format!("plugin `{plugin_id}` is not installed"));
        }
        let mut preferences = PluginPreferences::read(&self.app_data, &self.preference_limits)?;
        if enabled {
            preferences.disabled.remove(&plugin_id);
        } else {
            preferences.disabled.insert(plugin_id);
        }
        preferences.write(&self.app_data, &self.preference_limits)?;
        self.status(false)
    }

    pub(crate) fn set_plugin_safe_mode(&mut self, safe_mode: bool) -> Result<PluginStatus, String> {
        let mut preferences = PluginPreferences::read(&self.app_data, &self.preference_limits)?;
        preferences.safe_mode = safe_mode;
        preferences.write(&self.app_data, &self.preference_limits)?;
        self.status(!safe_mode)
    }

    pub(crate) fn set_plugin_hot_reload(&mut self, enabled: bool) -> Result<PluginStatus, String> {
        let mut preferences = PluginPreferences::read(&self.app_data, &self.preference_limits)?;
        preferences.hot_reload_enabled = enabled;
        preferences.write(&self.app_data, &self.preference_limits)?;
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
    pub(crate) fn read(
        app_data: &Path,
        limits: &PluginPreferenceLimits,
    ) -> Result<PluginPreferences, String> {
        let path = app_data.join("plugin-preferences.json");
        if !path.exists() {
            return Ok(PluginPreferences::default());
        }
        let mut source = String::new();
        fs::File::open(&path)
            .and_then(|file| {
                file.take(limits.max_plugin_preferences_bytes.saturating_add(1))
                    .read_to_string(&mut source)
            })
            .map_err(|error| error.to_string())?;
        if source.len() as u64 > limits.max_plugin_preferences_bytes {
            return Err("plugin preferences exceed the configured byte limit".into());
        }
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
            preferences.write(app_data, limits)?;
        }
        Ok(preferences)
    }

    pub(crate) fn write(
        &self,
        app_data: &Path,
        limits: &PluginPreferenceLimits,
    ) -> Result<(), String> {
        let path = app_data.join("plugin-preferences.json");
        let parent = path
            .parent()
            .ok_or_else(|| "plugin preferences path has no parent".to_owned())?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > limits.max_plugin_preferences_bytes {
            return Err("plugin preferences exceed the configured byte limit".into());
        }
        aster_project::AtomicFile::write(&path, |file| file.write_all(&bytes))
            .map_err(|error| error.to_string())
    }
}

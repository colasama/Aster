//! Bounded, debounced polling for developer WGSL hot reload.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque, hash_map::DefaultHasher},
    fs,
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{DiscoveryReport, PluginError, PluginLoadFailure, PluginManifest};

#[derive(Clone, Debug, clap::Args)]
pub struct HotReloadLimits {
    #[arg(long, default_value_t = Self::default().reload_debounce_ms)]
    pub reload_debounce_ms: u64,
    #[arg(long, default_value_t = Self::default().max_candidates)]
    pub max_candidates: usize,
    #[arg(long, default_value_t = Self::default().max_scan_entries)]
    pub max_scan_entries: usize,
    #[arg(long, default_value_t = Self::default().max_scan_depth)]
    pub max_scan_depth: usize,
    #[arg(long, default_value_t = Self::default().max_hashed_bytes)]
    pub max_hashed_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_diagnostics)]
    pub max_diagnostics: usize,
}
impl Default for HotReloadLimits {
    fn default() -> Self {
        Self {
            reload_debounce_ms: 350,
            max_candidates: 256,
            max_scan_entries: 512,
            max_scan_depth: 4,
            max_hashed_bytes: 64 * 1024 * 1024,
            max_diagnostics: 64,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotReloadDiagnostic {
    pub revision: u64,
    pub plugin: String,
    pub level: DiagnosticLevel,
    pub message: String,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticLevel {
    Info,
    Error,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotReloadStatus {
    pub enabled: bool,
    pub suspended_by_safe_mode: bool,
    pub pending: bool,
    pub revision: u64,
    pub successful_reloads: u64,
    pub rejected_reloads: u64,
    pub diagnostics: Vec<HotReloadDiagnostic>,
}

#[derive(Clone, Debug)]
pub struct HotReloadView {
    pub report: DiscoveryReport,
    pub status: HotReloadStatus,
}

#[derive(Default)]
pub struct HotReloadController {
    pub limits: HotReloadLimits,
    pub plugin_limits: crate::PluginLimits,
    active: BTreeMap<String, PluginManifest>,
    active_shader_sources: BTreeMap<String, BTreeMap<String, String>>,
    failures: Vec<PluginLoadFailure>,
    diagnostics: VecDeque<HotReloadDiagnostic>,
    observed_fingerprint: Option<u64>,
    changed_at: Option<Instant>,
    revision: u64,
    successful_reloads: u64,
    rejected_reloads: u64,
}

impl HotReloadController {
    pub fn new(limits: HotReloadLimits, plugin_limits: crate::PluginLimits) -> Self {
        Self {
            limits,
            plugin_limits,
            ..Default::default()
        }
    }

    /// Polls a plugin root once. Callers own scheduling; this never starts a watcher.
    pub fn poll(&mut self, root: impl AsRef<Path>) -> Result<HotReloadView, PluginError> {
        self.poll_at(root.as_ref(), Instant::now())
    }

    /// Immediately validates the set, used after installation or enabling hot reload.
    pub fn force_reload(&mut self, root: impl AsRef<Path>) -> Result<HotReloadView, PluginError> {
        let root = root.as_ref();
        let fingerprint = self.fingerprint(root)?;
        self.reload(root)?;
        self.observed_fingerprint = Some(fingerprint);
        self.changed_at = None;
        Ok(self.view(true, false))
    }

    pub fn inactive_view(&self, enabled: bool, safe_mode: bool) -> HotReloadView {
        let mut view = self.view(enabled, safe_mode);
        view.status.pending = false;
        view
    }

    fn poll_at(&mut self, root: &Path, now: Instant) -> Result<HotReloadView, PluginError> {
        let fingerprint = self.fingerprint(root)?;
        let Some(observed) = self.observed_fingerprint else {
            self.reload(root)?;
            self.observed_fingerprint = Some(fingerprint);
            return Ok(self.view(true, false));
        };
        if fingerprint != observed {
            self.observed_fingerprint = Some(fingerprint);
            self.changed_at = Some(now);
            return Ok(self.view(true, false));
        }
        if self.changed_at.is_some_and(|changed_at| {
            now.saturating_duration_since(changed_at)
                >= Duration::from_millis(self.limits.reload_debounce_ms)
        }) {
            self.reload(root)?;
            self.changed_at = None;
        }
        Ok(self.view(true, false))
    }

    fn reload(&mut self, root: &Path) -> Result<(), PluginError> {
        let repository = crate::PluginRepository {
            root: root.to_owned(),
            limits: self.plugin_limits.clone(),
        };
        let _access = repository.access()?;
        let candidates = self.candidates(root)?;
        self.revision = self.revision.saturating_add(1);
        let previous = self.active.clone();
        let previous_sources = self.active_shader_sources.clone();
        let mut active = BTreeMap::new();
        let mut active_shader_sources = BTreeMap::new();
        let mut failures = Vec::new();
        let mut ids = BTreeSet::new();
        let mut rejected = 0_u64;

        for (key, path) in candidates {
            match repository.limits.load(&path, true).and_then(|package| {
                crate::PluginMetadata::validate_external_id(&package.manifest.plugin.id)?;
                if !ids.insert(package.manifest.plugin.id.clone()) {
                    return Err(PluginError::DuplicatePluginId(package.manifest.plugin.id));
                }
                Ok(package)
            }) {
                Ok(package) => {
                    active_shader_sources
                        .insert(package.manifest.plugin.id.clone(), package.shader_sources);
                    active.insert(key, package.manifest);
                }
                Err(error) => {
                    rejected += 1;
                    let message = format!(
                        "Reload rejected; previous valid version retained when available: {}",
                        error.redacted(root)
                    );
                    if let Some(manifest) = previous.get(&key)
                        && ids.insert(manifest.plugin.id.clone())
                    {
                        active.insert(key.clone(), manifest.clone());
                    }
                    failures.push(PluginLoadFailure {
                        manifest: PathBuf::from(&key).join("plugin.toml"),
                        message: message.clone(),
                    });
                    self.push_diagnostic(key, DiagnosticLevel::Error, message);
                }
            }
        }

        for manifest in active.values() {
            if !active_shader_sources.contains_key(&manifest.plugin.id)
                && let Some(sources) = previous_sources.get(&manifest.plugin.id)
            {
                active_shader_sources.insert(manifest.plugin.id.clone(), sources.clone());
            }
        }

        self.active = active;
        self.active_shader_sources = active_shader_sources;
        self.failures = failures;
        if rejected == 0 {
            self.successful_reloads = self.successful_reloads.saturating_add(1);
            self.push_diagnostic(
                "runtime".into(),
                DiagnosticLevel::Info,
                format!("Activated {} validated plugin(s)", self.active.len()),
            );
        } else {
            self.rejected_reloads = self.rejected_reloads.saturating_add(rejected);
        }
        Ok(())
    }

    fn push_diagnostic(&mut self, plugin: String, level: DiagnosticLevel, message: String) {
        if self.limits.max_diagnostics == 0 {
            return;
        }
        while self.diagnostics.len() >= self.limits.max_diagnostics {
            self.diagnostics.pop_front();
        }
        self.diagnostics.push_back(HotReloadDiagnostic {
            revision: self.revision,
            plugin,
            level,
            message,
        });
    }

    fn view(&self, enabled: bool, safe_mode: bool) -> HotReloadView {
        HotReloadView {
            report: DiscoveryReport {
                plugins: self.active.values().cloned().collect(),
                failures: self.failures.clone(),
                shader_sources: self.active_shader_sources.clone(),
            },
            status: HotReloadStatus {
                enabled,
                suspended_by_safe_mode: safe_mode,
                pending: self.changed_at.is_some(),
                revision: self.revision,
                successful_reloads: self.successful_reloads,
                rejected_reloads: self.rejected_reloads,
                diagnostics: self.diagnostics.iter().cloned().collect(),
            },
        }
    }
}

impl HotReloadController {
    fn candidates(&self, root: &Path) -> Result<Vec<(String, PathBuf)>, PluginError> {
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut result = Vec::new();
        let mut scanned = 0_usize;
        for entry in fs::read_dir(root)? {
            scanned = scanned.saturating_add(1);
            if scanned > self.limits.max_scan_entries {
                return Err(PluginError::Io(std::io::Error::other(
                    "plugin candidate scan exceeds its entry limit",
                )));
            }
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            let candidate = if file_type.is_dir() {
                path.join("plugin.toml")
            } else {
                path
            };
            if candidate.file_name().and_then(|name| name.to_str()) == Some("plugin.toml") {
                let key = entry.file_name().to_string_lossy().into_owned();
                result.push((key, candidate));
            }
        }
        if result.len() > self.limits.max_candidates {
            return Err(PluginError::Io(std::io::Error::other(
                "plugin hot reload exceeds its candidate limit",
            )));
        }
        result.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(result)
    }
}

impl HotReloadController {
    fn fingerprint(&self, root: &Path) -> Result<u64, PluginError> {
        if !root.exists() {
            return Ok(0);
        }
        let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
        let mut paths = Vec::new();
        let mut entries = 0_usize;
        while let Some((directory, depth)) = queue.pop_front() {
            for entry in fs::read_dir(directory)? {
                entries += 1;
                if entries > self.limits.max_scan_entries {
                    return Err(PluginError::Io(std::io::Error::other(
                        "plugin hot reload scan exceeds its entry limit",
                    )));
                }
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() && depth < self.limits.max_scan_depth {
                    queue.push_back((path, depth + 1));
                } else if file_type.is_file()
                    && matches!(
                        path.extension().and_then(|extension| extension.to_str()),
                        Some("toml" | "wgsl")
                    )
                {
                    paths.push(path);
                }
            }
        }
        paths.sort();
        let mut hasher = DefaultHasher::new();
        let mut hashed_bytes = 0_u64;
        for path in paths {
            path.strip_prefix(root).unwrap_or(&path).hash(&mut hasher);
            let metadata = fs::metadata(&path)?;
            metadata.len().hash(&mut hasher);
            metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_nanos())
                .hash(&mut hasher);
            hashed_bytes = hashed_bytes.saturating_add(metadata.len());
            if hashed_bytes > self.limits.max_hashed_bytes {
                return Err(PluginError::Io(std::io::Error::other(
                    "plugin hot reload scan exceeds its byte limit",
                )));
            }
            let mut file = fs::File::open(path)?;
            let mut buffer = [0_u8; 64 * 1024];
            let mut actual = 0_u64;
            loop {
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                actual = actual.saturating_add(count as u64);
                if actual > metadata.len() {
                    return Err(PluginError::Io(std::io::Error::other(
                        "plugin file changed during fingerprinting",
                    )));
                }
                hasher.write(&buffer[..count]);
            }
            if actual != metadata.len() {
                return Err(PluginError::Io(std::io::Error::other(
                    "plugin file changed during fingerprinting",
                )));
            }
        }
        Ok(hasher.finish())
    }
}

impl PluginError {
    fn redacted(&self, root: &Path) -> String {
        let mut message = self.to_string();
        for root in [root.to_path_buf(), root.canonicalize().unwrap_or_default()] {
            let root = root.to_string_lossy();
            if !root.is_empty() {
                message = message.replace(root.as_ref(), "<plugins>");
            }
        }
        message
    }
}

#[cfg(test)]
mod tests;

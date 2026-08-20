//! Bounded, debounced polling for developer WGSL hot reload.

use std::{
    collections::{BTreeMap, BTreeSet, VecDeque, hash_map::DefaultHasher},
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

use serde::Serialize;

use crate::{DiscoveryReport, PluginError, PluginLoadFailure, PluginManifest};

const DEBOUNCE: Duration = Duration::from_millis(350);
const MAX_CANDIDATES: usize = 256;
const MAX_SCAN_ENTRIES: usize = 512;
const MAX_SCAN_DEPTH: usize = 4;
const MAX_HASHED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 64;

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
    active: BTreeMap<String, PluginManifest>,
    failures: Vec<PluginLoadFailure>,
    diagnostics: VecDeque<HotReloadDiagnostic>,
    observed_fingerprint: Option<u64>,
    changed_at: Option<Instant>,
    revision: u64,
    successful_reloads: u64,
    rejected_reloads: u64,
}

impl HotReloadController {
    /// Polls a plugin root once. Callers own scheduling; this never starts a watcher.
    pub fn poll(&mut self, root: impl AsRef<Path>) -> Result<HotReloadView, PluginError> {
        self.poll_at(root.as_ref(), Instant::now())
    }

    /// Immediately validates the set, used after installation or enabling hot reload.
    pub fn force_reload(&mut self, root: impl AsRef<Path>) -> Result<HotReloadView, PluginError> {
        let root = root.as_ref();
        self.observed_fingerprint = Some(fingerprint(root)?);
        self.changed_at = None;
        self.reload(root)?;
        Ok(self.view(true, false))
    }

    pub fn inactive_view(&self, enabled: bool, safe_mode: bool) -> HotReloadView {
        let mut view = self.view(enabled, safe_mode);
        view.status.pending = false;
        view
    }

    fn poll_at(&mut self, root: &Path, now: Instant) -> Result<HotReloadView, PluginError> {
        let fingerprint = fingerprint(root)?;
        let Some(observed) = self.observed_fingerprint else {
            self.observed_fingerprint = Some(fingerprint);
            self.reload(root)?;
            return Ok(self.view(true, false));
        };
        if fingerprint != observed {
            self.observed_fingerprint = Some(fingerprint);
            self.changed_at = Some(now);
            return Ok(self.view(true, false));
        }
        if self
            .changed_at
            .is_some_and(|changed_at| now.saturating_duration_since(changed_at) >= DEBOUNCE)
        {
            self.changed_at = None;
            self.reload(root)?;
        }
        Ok(self.view(true, false))
    }

    fn reload(&mut self, root: &Path) -> Result<(), PluginError> {
        self.revision = self.revision.saturating_add(1);
        let previous = std::mem::take(&mut self.active);
        let mut active = BTreeMap::new();
        let mut failures = Vec::new();
        let mut ids = BTreeSet::new();
        let mut rejected = 0_u64;

        for (key, path) in candidates(root)? {
            match PluginManifest::load(&path) {
                Ok(manifest) if ids.insert(manifest.plugin.id.clone()) => {
                    active.insert(key, manifest);
                }
                Ok(manifest) => {
                    rejected += 1;
                    let message = format!(
                        "Reload rejected: duplicate plugin id `{}`; previous valid version retained when available",
                        manifest.plugin.id
                    );
                    retain_previous(&previous, &mut active, &mut ids, &key);
                    failures.push(failure(&key, &message));
                    self.push_diagnostic(key, DiagnosticLevel::Error, message);
                }
                Err(error) => {
                    rejected += 1;
                    let message = format!(
                        "Reload rejected; previous valid version retained when available: {}",
                        redact_error(root, &error)
                    );
                    retain_previous(&previous, &mut active, &mut ids, &key);
                    failures.push(failure(&key, &message));
                    self.push_diagnostic(key, DiagnosticLevel::Error, message);
                }
            }
        }

        self.active = active;
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
        if self.diagnostics.len() == MAX_DIAGNOSTICS {
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

fn retain_previous(
    previous: &BTreeMap<String, PluginManifest>,
    active: &mut BTreeMap<String, PluginManifest>,
    ids: &mut BTreeSet<String>,
    key: &str,
) {
    if let Some(manifest) = previous.get(key)
        && ids.insert(manifest.plugin.id.clone())
    {
        active.insert(key.to_owned(), manifest.clone());
    }
}

fn failure(key: &str, message: &str) -> PluginLoadFailure {
    PluginLoadFailure {
        manifest: PathBuf::from(key).join("plugin.toml"),
        message: message.to_owned(),
    }
}

fn candidates(root: &Path) -> Result<Vec<(String, PathBuf)>, PluginError> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in fs::read_dir(root)?.take(MAX_CANDIDATES + 1) {
        let entry = entry?;
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
            let key: String = entry
                .file_name()
                .to_string_lossy()
                .chars()
                .take(96)
                .collect();
            result.push((key, candidate));
        }
    }
    if result.len() > MAX_CANDIDATES {
        return Err(limit_error(
            "plugin hot reload supports at most 256 candidates",
        ));
    }
    result.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(result)
}

fn fingerprint(root: &Path) -> Result<u64, PluginError> {
    if !root.exists() {
        return Ok(0);
    }
    let mut queue = VecDeque::from([(root.to_path_buf(), 0_usize)]);
    let mut paths = Vec::new();
    let mut entries = 0_usize;
    while let Some((directory, depth)) = queue.pop_front() {
        for entry in fs::read_dir(directory)? {
            entries += 1;
            if entries > MAX_SCAN_ENTRIES {
                return Err(limit_error("plugin hot reload scan exceeds 512 entries"));
            }
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() && depth < MAX_SCAN_DEPTH {
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
        if hashed_bytes > MAX_HASHED_BYTES {
            return Err(limit_error("plugin hot reload scan exceeds 64 MiB"));
        }
        fs::read(path)?.hash(&mut hasher);
    }
    Ok(hasher.finish())
}

fn redact_error(root: &Path, error: &PluginError) -> String {
    let mut message = error.to_string();
    for root in [root.to_path_buf(), root.canonicalize().unwrap_or_default()] {
        let root = root.to_string_lossy();
        if !root.is_empty() {
            message = message.replace(root.as_ref(), "<plugins>");
        }
    }
    message
}

fn limit_error(message: &str) -> PluginError {
    PluginError::Io(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        message,
    ))
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const VALID_EFFECT: &str = r#"
struct AsterEffectUniforms {
    resolution: vec2f,
    time: f32,
    parameter_count: u32,
    parameters: array<vec4f, 16>,
}
@group(0) @binding(0) var aster_source: texture_2d<f32>;
@group(0) @binding(1) var aster_sampler: sampler;
@group(0) @binding(2) var<uniform> aster: AsterEffectUniforms;
@fragment
fn aster_effect(@location(0) uv: vec2f) -> @location(0) vec4f {
    return textureSample(aster_source, aster_sampler, uv);
}
"#;

    #[test]
    fn debounces_changes_and_retains_the_last_valid_shader() {
        let root = temp_root("retain");
        write_plugin(&root, "1.0.0", VALID_EFFECT);
        let mut controller = HotReloadController::default();
        let start = Instant::now();
        let initial = controller.poll_at(&root, start).unwrap();
        assert_eq!(initial.report.plugins[0].plugin.version, "1.0.0");

        write_plugin(&root, "2.0.0", "this is not wgsl");
        let pending = controller
            .poll_at(&root, start + Duration::from_millis(10))
            .unwrap();
        assert!(pending.status.pending);
        assert_eq!(pending.report.plugins[0].plugin.version, "1.0.0");
        let rejected = controller
            .poll_at(&root, start + Duration::from_millis(400))
            .unwrap();
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
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn activates_a_valid_update_after_the_debounce_window() {
        let root = temp_root("activate");
        write_plugin(&root, "1.0.0", VALID_EFFECT);
        let mut controller = HotReloadController::default();
        let start = Instant::now();
        controller.poll_at(&root, start).unwrap();
        write_plugin(&root, "1.1.0", &format!("{VALID_EFFECT}\n// changed"));
        controller
            .poll_at(&root, start + Duration::from_millis(1))
            .unwrap();
        let updated = controller
            .poll_at(&root, start + Duration::from_millis(400))
            .unwrap();
        assert_eq!(updated.report.plugins[0].plugin.version, "1.1.0");
        assert_eq!(updated.status.successful_reloads, 2);
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aster-plugin-hot-reload-{name}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_plugin(root: &Path, version: &str, shader: &str) {
        let plugin = root.join("example");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(
            plugin.join("plugin.toml"),
            format!(
                "[plugin]\nid = \"com.example.reload\"\nname = \"Reload\"\nversion = \"{version}\"\napi_version = 1\nshader = \"effect.wgsl\"\n"
            ),
        )
        .unwrap();
        fs::write(plugin.join("effect.wgsl"), shader).unwrap();
    }
}

use crate::{
    DiscoveryReport, PluginError, PluginLimits, PluginLoadFailure, PluginManifest, PluginMetadata,
};
use aster_storage::{DirectoryPublication, PendingDirectory};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

pub struct PluginRepository {
    pub root: PathBuf,
    pub limits: PluginLimits,
}

impl PluginRepository {
    pub fn at(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().to_owned(),
            limits: PluginLimits::default(),
        }
    }

    pub(crate) fn access(&self) -> Result<DirectoryPublication, PluginError> {
        let access = DirectoryPublication::acquire(&self.root)?;
        if self.root.exists() {
            for (index, entry) in fs::read_dir(&self.root)?.enumerate() {
                if index >= self.limits.max_scan_entries {
                    return Err(PluginError::Io(std::io::Error::other(
                        "plugin scan exceeds its entry limit",
                    )));
                }
                let entry = entry?;
                let name = entry.file_name();
                let Some(id) = name
                    .to_str()
                    .and_then(|name| name.strip_suffix(".aster-backup"))
                else {
                    continue;
                };
                if PluginMetadata::valid_plugin_id(id) {
                    DirectoryPublication::acquire(&self.root.join(id))?;
                }
            }
        }
        Ok(access)
    }

    pub fn discover(
        &self,
        should_load_runtime: impl Fn(&str) -> bool,
    ) -> Result<DiscoveryReport, PluginError> {
        let _access = self.access()?;
        if !self.root.exists() {
            return Ok(DiscoveryReport::default());
        }
        let mut manifests = Vec::new();
        for (index, entry) in fs::read_dir(&self.root)?.enumerate() {
            if index >= self.limits.max_scan_entries {
                return Err(PluginError::Io(std::io::Error::other(
                    "plugin scan exceeds its entry limit",
                )));
            }
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let path = entry.path();
            if Self::is_link(&path)? {
                continue;
            }
            let candidate = if path.is_dir() {
                path.join("plugin.toml")
            } else {
                path
            };
            if candidate.file_name().and_then(|name| name.to_str()) == Some("plugin.toml") {
                if manifests.len() >= self.limits.max_candidates {
                    return Err(PluginError::Io(std::io::Error::other(
                        "plugin scan exceeds its candidate limit",
                    )));
                }
                manifests.push(candidate);
            }
        }
        manifests.sort();
        let mut report = DiscoveryReport::default();
        let mut ids = BTreeSet::new();
        for path in manifests {
            let loaded = self.limits.load(&path, false).and_then(|mut package| {
                PluginMetadata::validate_external_id(&package.manifest.plugin.id)?;
                if !ids.insert(package.manifest.plugin.id.clone()) {
                    return Err(PluginError::DuplicatePluginId(package.manifest.plugin.id));
                }
                if should_load_runtime(&package.manifest.plugin.id) {
                    package.load_shaders(
                        path.parent().unwrap_or_else(|| Path::new(".")),
                        &self.limits,
                    )?;
                }
                Ok(package)
            });
            match loaded {
                Ok(package) => {
                    if !package.shader_sources.is_empty() {
                        report
                            .shader_sources
                            .insert(package.manifest.plugin.id.clone(), package.shader_sources);
                    }
                    report.plugins.push(package.manifest);
                }
                Err(error) => report.failures.push(PluginLoadFailure {
                    manifest: path,
                    message: error.to_string(),
                }),
            }
        }
        Ok(report)
    }

    pub(crate) fn is_link(path: &Path) -> std::io::Result<bool> {
        let metadata = fs::symlink_metadata(path)?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            Ok(metadata.file_attributes() & 0x400 != 0)
        }
        #[cfg(not(windows))]
        {
            Ok(metadata.file_type().is_symlink())
        }
    }

    /// Publishes the exact validated manifest and shader snapshot.
    pub fn install(&self, source: impl AsRef<Path>) -> Result<PluginManifest, PluginError> {
        let source = source.as_ref().canonicalize()?;
        let package = self.limits.load(source.join("plugin.toml"), true)?;
        PluginMetadata::validate_external_id(&package.manifest.plugin.id)?;
        let _access = self.access()?;
        fs::create_dir_all(&self.root)?;
        let destination = self.root.join(&package.manifest.plugin.id);
        let publication = DirectoryPublication::acquire(&destination)?;
        let pending = PendingDirectory::create(&self.root)?;
        for (relative, contents) in
            std::iter::once(("plugin.toml", package.manifest_source.as_str())).chain(
                package
                    .shader_sources
                    .iter()
                    .map(|(path, source)| (path.as_str(), source.as_str())),
            )
        {
            let destination = pending.path.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut file = fs::File::options()
                .write(true)
                .create_new(true)
                .open(destination)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
        }
        publication.replace(&pending.path)?;
        Ok(package.manifest)
    }
}

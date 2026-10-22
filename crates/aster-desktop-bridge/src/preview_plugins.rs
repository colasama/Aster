use crate::plugins::PluginHost;
use aster_plugin::{PluginKind, PluginMetadata};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, clap::Args)]
pub(crate) struct PreviewPluginLimits {
    #[arg(long, default_value_t = Self::default().max_preview_plugin_snapshot_bytes)]
    pub(crate) max_preview_plugin_snapshot_bytes: u64,
}

impl Default for PreviewPluginLimits {
    fn default() -> Self {
        Self {
            max_preview_plugin_snapshot_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct PreviewGeneratorReference {
    pub(crate) plugin_id: String,
    pub(crate) node_type: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PreviewPluginRequest {
    pub(crate) references: Vec<PreviewGeneratorReference>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewPluginPackage {
    pub(crate) plugin_id: String,
    pub(crate) node_type: String,
    pub(crate) manifest_toml: String,
    pub(crate) shader_sources: BTreeMap<String, String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum UnavailableReason {
    SafeMode,
    Disabled,
    Missing,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnavailablePreviewGenerator {
    pub(crate) plugin_id: String,
    pub(crate) node_type: String,
    pub(crate) reason: UnavailableReason,
}

#[derive(Debug, Serialize)]
pub(crate) struct PreviewPluginSnapshot {
    pub(crate) packages: Vec<PreviewPluginPackage>,
    pub(crate) unavailable: Vec<UnavailablePreviewGenerator>,
}

impl PluginHost {
    /// Main-process consumers receive the admitted runtime, including the last valid hot reload.
    pub(crate) fn prepare_preview_plugins(
        &mut self,
        request: PreviewPluginRequest,
    ) -> Result<PreviewPluginSnapshot, String> {
        if request.references.len() > self.limits.max_candidates {
            return Err("too many preview generator references".into());
        }
        let mut references = BTreeSet::new();
        for reference in request.references {
            if !PluginMetadata::valid_plugin_id(&reference.plugin_id)
                || reference.plugin_id == "org.aster.builtin"
                || reference.plugin_id.starts_with("org.aster.builtin.")
                || reference.node_type.is_empty()
                || reference.node_type.len() > 256
                || reference.node_type.chars().any(char::is_control)
                || !references.insert(reference)
            {
                return Err("invalid or duplicate preview generator reference".into());
            }
        }
        let status = self.load_plugin_runtime(
            references
                .iter()
                .map(|item| item.plugin_id.clone())
                .collect(),
        )?;
        let mut snapshot = PreviewPluginSnapshot {
            packages: Vec::new(),
            unavailable: Vec::new(),
        };
        let mut bytes = 0_u64;
        for reference in references {
            let manifest = status.report.plugins.iter().find(|manifest| {
                manifest.plugin.id == reference.plugin_id
                    && manifest.plugin.kind == PluginKind::SceneGenerator
                    && manifest
                        .scene_generator
                        .as_ref()
                        .is_some_and(|graph| graph.node_type == reference.node_type)
            });
            let shaders = status.report.shader_sources.get(&reference.plugin_id);
            let unavailable = if status.safe_mode {
                Some(UnavailableReason::SafeMode)
            } else if status.disabled.contains(&reference.plugin_id) {
                Some(UnavailableReason::Disabled)
            } else if manifest.is_none() || shaders.is_none_or(BTreeMap::is_empty) {
                Some(UnavailableReason::Missing)
            } else {
                None
            };
            if let Some(reason) = unavailable {
                tracing::warn!(
                    event = "preview_generator_unavailable",
                    plugin_id = %reference.plugin_id,
                    node_type = %reference.node_type,
                    reason = ?reason,
                    "preview generator is unavailable; retaining the surrounding scene"
                );
                snapshot.unavailable.push(UnavailablePreviewGenerator {
                    plugin_id: reference.plugin_id,
                    node_type: reference.node_type,
                    reason,
                });
                continue;
            }
            let manifest = manifest.ok_or("admitted preview manifest is absent")?;
            let shaders = shaders.ok_or("admitted preview shader sources are absent")?;
            let source = self
                .limits
                .serialize_manifest(manifest)
                .map_err(|error| error.to_string())?;
            bytes = bytes.saturating_add(source.len() as u64);
            for (path, shader) in shaders {
                bytes = bytes.saturating_add((path.len() + shader.len()) as u64);
            }
            if bytes > self.snapshot_limits.max_preview_plugin_snapshot_bytes {
                return Err("preview plugin snapshot exceeds its byte budget".into());
            }
            snapshot.packages.push(PreviewPluginPackage {
                plugin_id: reference.plugin_id,
                node_type: reference.node_type,
                manifest_toml: source,
                shader_sources: shaders.clone(),
            });
        }
        Ok(snapshot)
    }
}

#[cfg(test)]
#[path = "preview_plugins_tests.rs"]
mod tests;

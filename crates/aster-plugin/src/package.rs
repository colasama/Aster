use crate::{PluginError, PluginKind, PluginManifest};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, clap::Args)]
pub struct PluginLimits {
    #[arg(long, default_value_t = Self::default().max_candidates)]
    pub max_candidates: usize,
    #[arg(long, default_value_t = Self::default().max_scan_entries)]
    pub max_scan_entries: usize,
    #[command(flatten)]
    pub generator: crate::generator::GeneratorLimits,
    #[arg(long, default_value_t = Self::default().max_shader_bytes)]
    pub max_shader_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_plugin_shader_bytes)]
    pub max_plugin_shader_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_manifest_bytes)]
    pub max_manifest_bytes: u64,
}
impl Default for PluginLimits {
    fn default() -> Self {
        Self {
            generator: crate::generator::GeneratorLimits::default(),
            max_candidates: 256,
            max_scan_entries: 512,
            max_shader_bytes: 4 * 1024 * 1024,
            max_plugin_shader_bytes: 16 * 1024 * 1024,
            max_manifest_bytes: 1024 * 1024,
        }
    }
}

#[derive(Debug)]
pub struct PluginPackage {
    pub manifest: PluginManifest,
    pub shader_sources: BTreeMap<String, String>,
    pub(crate) manifest_source: String,
}

impl PluginLimits {
    pub fn parse_manifest(&self, source: &str) -> Result<PluginManifest, PluginError> {
        if source.len() as u64 > self.max_manifest_bytes {
            return Err(PluginError::ManifestTooLarge(source.len() as u64));
        }
        let manifest: PluginManifest = toml::from_str(source)?;
        manifest.validate(self)?;
        Ok(manifest)
    }

    pub fn load(
        &self,
        path: impl AsRef<Path>,
        runtime: bool,
    ) -> Result<PluginPackage, PluginError> {
        let path = path.as_ref();
        let mut source = String::new();
        File::open(path)?
            .take(self.max_manifest_bytes.saturating_add(1))
            .read_to_string(&mut source)?;
        let mut package = PluginPackage {
            manifest: self.parse_manifest(&source)?,
            manifest_source: source,
            shader_sources: BTreeMap::new(),
        };
        if runtime {
            package.load_shaders(path.parent().unwrap_or_else(|| Path::new(".")), self)?;
        }
        Ok(package)
    }
}

impl PluginPackage {
    pub(crate) fn load_shaders(
        &mut self,
        directory: &Path,
        limits: &PluginLimits,
    ) -> Result<(), PluginError> {
        let resolved_directory = directory.canonicalize()?;
        let mut paths = BTreeSet::from([self.manifest.plugin.shader.as_str()]);
        if let Some(graph) = &self.manifest.scene_generator {
            paths.extend(graph.shader_paths());
        }
        let mut sources = BTreeMap::new();
        let mut total = 0_u64;
        for relative in paths {
            let path = directory.join(relative);
            if !path.is_file() {
                return Err(PluginError::MissingShader(path));
            }
            let resolved = path.canonicalize()?;
            if !resolved.starts_with(&resolved_directory) {
                return Err(PluginError::ShaderOutsidePlugin(resolved));
            }
            let mut source = String::new();
            File::open(resolved)?
                .take(limits.max_shader_bytes.saturating_add(1))
                .read_to_string(&mut source)?;
            if source.len() as u64 > limits.max_shader_bytes {
                return Err(PluginError::ShaderTooLarge(source.len() as u64));
            }
            total = total.saturating_add(source.len() as u64);
            if total > limits.max_plugin_shader_bytes {
                return Err(PluginError::ShaderPackageTooLarge(total));
            }
            sources.insert(relative.to_owned(), source);
        }
        match self.manifest.plugin.kind {
            PluginKind::Effect => {
                let source = sources.get(&self.manifest.plugin.shader).ok_or_else(|| {
                    PluginError::MissingShader(PathBuf::from(&self.manifest.plugin.shader))
                })?;
                crate::EffectAbi::validate_source(source)?;
            }
            PluginKind::SceneGenerator => crate::SceneGeneratorValidator {
                limits: limits.clone(),
            }
            .validate(&self.manifest, &sources)?,
        }
        self.shader_sources = sources;
        Ok(())
    }
}

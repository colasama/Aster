use std::{collections::BTreeSet, fs, io::Write, path::Path};

use aster_shaders::ShaderCatalog;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EffectEntry {
    #[serde(rename = "type")]
    pub effect_type: String,
    pub name: String,
    pub case_id: String,
    pub ops: Vec<Vec<f32>>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ShaderDigest {
    pub id: String,
    pub sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EffectManifest {
    schema_version: u32,
    kind: String,
    width: u32,
    height: u32,
    time: f32,
    parameter_source: String,
    registry_types: Vec<String>,
    corpus_sha256: String,
    shader_manifest_sha256: String,
    shader_programs: Vec<ShaderDigest>,
    pub effects: Vec<EffectEntry>,
}

pub struct HarnessInput {
    pub manifest: EffectManifest,
    pub manifest_sha256: String,
    pub shader_sources: Vec<ShaderDigest>,
    pub post_process: String,
    pub blur_downsample: String,
    pub brightpass_downsample: String,
}

impl HarnessInput {
    pub fn load(directory: &Path) -> Result<Self, String> {
        let bytes = fs::read(directory.join("effects.json"))
            .map_err(|error| format!("reading effects.json failed: {error}"))?;
        let manifest: EffectManifest = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parsing effects.json failed: {error}"))?;
        manifest.validate()?;
        let catalog = ShaderCatalog::embedded().map_err(|error| error.to_string())?;
        let mut shader_sources = Vec::new();
        for id in ["post-process", "blur-downsample", "brightpass-downsample"] {
            let program = catalog.program(id).map_err(|error| error.to_string())?;
            shader_sources.push(ShaderDigest {
                id: id.to_owned(),
                sha256: format!("{:x}", Sha256::digest(program.source.as_bytes())),
            });
        }
        if manifest.shader_programs != shader_sources {
            return Err("TS and native shared shader program hashes differ".to_owned());
        }
        Ok(Self {
            manifest,
            manifest_sha256: format!("{:x}", Sha256::digest(&bytes)),
            shader_sources,
            post_process: catalog
                .program("post-process")
                .map_err(|error| error.to_string())?
                .source
                .clone(),
            blur_downsample: catalog
                .program("blur-downsample")
                .map_err(|error| error.to_string())?
                .source
                .clone(),
            brightpass_downsample: catalog
                .program("brightpass-downsample")
                .map_err(|error| error.to_string())?
                .source
                .clone(),
        })
    }
}

impl EffectManifest {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || self.kind != "effect-shot-ops"
            || self.width != super::WIDTH
            || self.height != super::HEIGHT
            || self.time != 0.5
            || self.parameter_source != "registry-defaults"
        {
            return Err("Unsupported effect-shot manifest contract".to_owned());
        }
        if self.corpus_sha256.len() != 64
            || !self
                .corpus_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            || self.shader_manifest_sha256
                != format!(
                    "{:x}",
                    Sha256::digest(include_bytes!("../../../../shaders/manifest.json"))
                )
        {
            return Err("Invalid corpus or shared shader manifest identity".to_owned());
        }
        let actual_types = self
            .effects
            .iter()
            .map(|entry| entry.effect_type.as_str())
            .collect::<Vec<_>>();
        if actual_types.is_empty()
            || actual_types.iter().copied().collect::<BTreeSet<_>>().len() != actual_types.len()
            || actual_types
                != self
                    .registry_types
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
        {
            return Err("Effect entries must cover the registry exactly once in order".to_owned());
        }
        for entry in &self.effects {
            if entry.effect_type.split('-').any(|part| {
                part.is_empty()
                    || !part
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            }) || entry.name.is_empty()
                || entry.case_id != format!("effect-{}", entry.effect_type)
                || entry.ops.is_empty()
                || entry.ops.len() > super::MAX_OPERATIONS
                || entry.ops.iter().any(|op| {
                    op.len() != super::FLOATS_PER_OPERATION
                        || !op.iter().all(|value| value.is_finite())
                })
            {
                return Err(format!(
                    "Invalid operation or case data for {}",
                    entry.effect_type
                ));
            }
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct AdapterReport {
    name: String,
    vendor: u32,
    device: u32,
    device_type: String,
    driver: String,
    driver_info: String,
    backend: String,
}

impl From<wgpu::AdapterInfo> for AdapterReport {
    fn from(info: wgpu::AdapterInfo) -> Self {
        Self {
            name: info.name,
            vendor: info.vendor,
            device: info.device,
            device_type: format!("{:?}", info.device_type),
            driver: info.driver,
            driver_info: info.driver_info,
            backend: format!("{:?}", info.backend),
        }
    }
}

#[derive(Serialize)]
pub struct ImageReport {
    #[serde(rename = "type")]
    pub effect_type: String,
    pub file: String,
    pub width: u32,
    pub height: u32,
    pub png_sha256: String,
}

#[derive(Serialize)]
pub struct NativeReport {
    pub schema_version: u32,
    pub status: String,
    pub effects_manifest_sha256: String,
    pub shader_sources: Vec<ShaderDigest>,
    pub adapter: AdapterReport,
    pub images: Vec<ImageReport>,
}

impl NativeReport {
    pub fn publish(&self, directory: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| error.to_string())?;
        let temporary = directory.join("report.json.pending");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("creating report failed: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("writing report failed: {error}"))?;
        drop(file);
        fs::rename(temporary, directory.join("report.json"))
            .map_err(|error| format!("publishing report failed: {error}"))
    }
}

#[cfg(test)]
#[path = "harness_tests.rs"]
mod tests;

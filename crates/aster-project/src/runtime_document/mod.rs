//! Runtime-only schema upgrades leave authored project files untouched.
mod camera;
mod json;
mod media;
mod particle;
mod text;

use crate::{ProjectBundle, ProjectError};
use json::{Json, Object};
use serde::Serialize;

pub struct RuntimeProjectDocument {
    document: Object,
    source_version: u64,
    max_output_bytes: usize,
}
#[derive(Clone, Debug)]
pub struct RuntimeProjectLimits {
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
    pub max_compositions: usize,
    pub max_project_layers: usize,
}
impl Default for RuntimeProjectLimits {
    fn default() -> Self {
        Self {
            max_input_bytes: 67_108_864,
            max_output_bytes: 67_108_864,
            max_compositions: 4096,
            max_project_layers: 65536,
        }
    }
}
struct BoundedOutput {
    bytes: Vec<u8>,
    limit: usize,
}
impl std::io::Write for BoundedOutput {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            return Err(std::io::Error::other(
                "normalized project exceeds output byte limit",
            ));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
#[derive(Clone, Copy, Serialize)]
struct StaticProperty {
    mode: &'static str,
    value: f64,
}
impl StaticProperty {
    fn at(value: f64) -> Self {
        Self {
            mode: "static",
            value,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MotionDefaults {
    enabled: bool,
    shutter_angle: u32,
    shutter_phase: i32,
    samples_per_frame: u32,
    adaptive_sample_limit: u32,
}
impl RuntimeProjectDocument {
    pub fn from_slice(bytes: &[u8], limits: &RuntimeProjectLimits) -> Result<Self, ProjectError> {
        if bytes.len() > limits.max_input_bytes || limits.max_output_bytes == 0 {
            return Err(ProjectError::InvalidEditorDocument(
                "runtime project byte limit",
            ));
        }
        let mut value: serde_json::Value = serde_json::from_slice(bytes)?;
        let version = value
            .get("schemaVersion")
            .and_then(serde_json::Value::as_f64)
            .filter(|v| {
                v.is_finite()
                    && v.fract() == 0.0
                    && *v >= 1.0
                    && *v <= ProjectBundle::EDITOR_SCHEMA_VERSION as f64
            })
            .ok_or(ProjectError::InvalidEditorDocument(
                "unsupported runtime schema version",
            ))? as u64;
        value["schemaVersion"] = serde_json::Value::from(version);
        ProjectBundle::validate_editor(&value, true)?;
        let compositions = value
            .get("compositions")
            .and_then(serde_json::Value::as_array)
            .ok_or(ProjectError::NoCompositions)?;
        let layers = compositions.iter().try_fold(0usize, |count, composition| {
            count.checked_add(
                composition
                    .get("layers")
                    .and_then(serde_json::Value::as_array)
                    .map_or(0, Vec::len),
            )
        });
        if compositions.len() > limits.max_compositions
            || layers.is_none_or(|count| count > limits.max_project_layers)
        {
            return Err(ProjectError::InvalidEditorDocument(
                "runtime project composition or layer limit",
            ));
        }
        drop(value);
        let Json::Object(mut document) = serde_json::from_slice(bytes)? else {
            return Err(ProjectError::InvalidEditorDocument(
                "project must be an object",
            ));
        };
        document.set("schemaVersion", Json::typed(&version)?);
        for version in version..ProjectBundle::EDITOR_SCHEMA_VERSION {
            match version {
                1 => Self::particles(&mut document)?,
                2 => {}
                3 => Self::sources(&mut document)?,
                4 => Self::audio(&mut document)?,
                5 | 8 => Self::cameras(&mut document, version)?,
                6 => Self::motion(&mut document)?,
                7 => Self::text(&mut document)?,
                9 => Self::anchors(&mut document)?,
                _ => {
                    return Err(ProjectError::InvalidEditorDocument(
                        "unsupported runtime upgrade",
                    ));
                }
            }
            document.set("schemaVersion", Json::typed(&(version + 1))?);
        }
        if document
            .get("folders")
            .is_none_or(|value| matches!(value, Json::Null))
        {
            document.set("folders", Json::Array(Vec::new()));
        }
        if document
            .get("itemFolderIds")
            .is_none_or(|value| matches!(value, Json::Null))
        {
            document.set("itemFolderIds", Json::Object(Object::default()));
        }
        Ok(Self {
            document,
            source_version: version,
            max_output_bytes: limits.max_output_bytes,
        })
    }
    pub fn source_version(&self) -> u64 {
        self.source_version
    }
    pub fn encode(&self) -> Result<Vec<u8>, ProjectError> {
        let mut output = BoundedOutput {
            bytes: Vec::new(),
            limit: self.max_output_bytes,
        };
        serde_json::to_writer(&mut output, &self.document)?;
        Ok(output.bytes)
    }
    fn compositions(document: &mut Object) -> impl Iterator<Item = &mut Object> {
        document
            .get_mut("compositions")
            .and_then(Json::array_mut)
            .into_iter()
            .flatten()
            .filter_map(Json::object_mut)
    }
    fn layers(composition: &mut Object) -> impl Iterator<Item = &mut Object> {
        composition
            .get_mut("layers")
            .and_then(Json::array_mut)
            .into_iter()
            .flatten()
            .filter_map(Json::object_mut)
    }
    fn motion(document: &mut Object) -> Result<(), ProjectError> {
        let motion = Json::typed(&MotionDefaults {
            enabled: false,
            shutter_angle: 180,
            shutter_phase: -90,
            samples_per_frame: 8,
            adaptive_sample_limit: 32,
        })?;
        for composition in Self::compositions(document) {
            composition.set("motionBlur", motion.clone());
            for layer in Self::layers(composition) {
                layer.set("motionBlur", Json::Bool(false));
            }
        }
        Ok(())
    }
    fn anchors(document: &mut Object) -> Result<(), ProjectError> {
        for composition in Self::compositions(document) {
            for layer in Self::layers(composition) {
                let Some(size) = layer
                    .get("size")
                    .and_then(Json::array)
                    .filter(|v| v.len() == 2)
                else {
                    continue;
                };
                let anchor = [
                    StaticProperty::at(size[0].finite().unwrap_or(0.0).max(0.0) * 0.5),
                    StaticProperty::at(size[1].finite().unwrap_or(0.0).max(0.0) * 0.5),
                    StaticProperty::at(0.0),
                ];
                if let Some(transform) = layer.get_mut("transform").and_then(Json::object_mut) {
                    transform.set("anchor", Json::typed(&anchor)?);
                }
            }
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests;

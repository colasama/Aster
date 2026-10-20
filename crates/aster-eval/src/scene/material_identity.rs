use super::SceneProject;
use crate::{
    EvaluationError, EvaluationLimits, ExpressionLimits, SceneLimits, javascript::JavaScriptNumber,
};
use aster_types::editor::{Layer, Project};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{MapAccess, Visitor},
};
use serde_json::Number;
use std::{collections::BTreeMap, fmt};

/// Render IDs deliberately retain ECMAScript JSON property order rather than canonical IR order.
pub struct RenderIdentity;
#[derive(Deserialize)]
#[serde(untagged)]
enum OrderedJson {
    Object(OrderedObject),
    Array(Vec<OrderedJson>),
    String(String),
    Number(Number),
    Bool(bool),
    Null(()),
}
struct OrderedObject(Vec<(String, OrderedJson)>);
struct ObjectVisitor;
impl<'de> Deserialize<'de> for OrderedObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(ObjectVisitor)
    }
}
impl<'de> Visitor<'de> for ObjectVisitor {
    type Value = OrderedObject;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON object with ordered properties")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut values: Vec<(String, OrderedJson)> = Vec::new();
        let mut indices = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, OrderedJson>()? {
            if let Some(index) = indices.get(&key).copied() {
                values[index] = (key, value);
            } else {
                indices.insert(key.clone(), values.len());
                values.push((key, value));
            }
        }
        Ok(OrderedObject(values))
    }
}
impl OrderedJson {
    fn write(&self, output: &mut String) -> Result<(), EvaluationError> {
        match self {
            Self::Null(()) => output.push_str("null"),
            Self::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
            Self::Number(value) => output.push_str(&JavaScriptNumber::number(value)),
            Self::String(value) => output.push_str(
                &serde_json::to_string(value)
                    .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?,
            ),
            Self::Array(values) => {
                output.push('[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    value.write(output)?;
                }
                output.push(']');
            }
            Self::Object(OrderedObject(values)) => {
                let mut integers = BTreeMap::new();
                let mut strings = Vec::new();
                for (key, value) in values {
                    if let Ok(index) = key.parse::<u32>()
                        && index < u32::MAX
                        && index.to_string() == *key
                    {
                        integers.insert(index, (key, value));
                    } else {
                        strings.push((key, value));
                    }
                }
                output.push('{');
                for (index, (key, value)) in integers.into_values().chain(strings).enumerate() {
                    if index > 0 {
                        output.push(',');
                    }
                    output.push_str(
                        &serde_json::to_string(key)
                            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?,
                    );
                    output.push(':');
                    value.write(output)?;
                }
                output.push('}');
            }
        }
        Ok(())
    }
}
impl RenderIdentity {
    pub fn encode(value: &str) -> u32 {
        let mut hash = 0x811c9dc5_u32;
        for unit in value.encode_utf16() {
            hash = (hash ^ u32::from(unit)).wrapping_mul(0x01000193);
        }
        if hash == 0 { 1 } else { hash }
    }
    pub(super) fn material(layer: &Layer) -> Result<u32, EvaluationError> {
        let material = layer
            .material
            .value()
            .or_else(|| layer.mesh.value().and_then(|m| m.source_material.value()));
        match material {
            Some(material) => Self::serialized(material),
            None => Self::serialized(&layer.kind),
        }
    }
    fn serialized(value: &impl Serialize) -> Result<u32, EvaluationError> {
        let bytes =
            serde_json::to_vec(value).map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let value: OrderedJson = serde_json::from_slice(&bytes)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let mut key = String::from("material:");
        value.write(&mut key)?;
        Ok(Self::encode(&key))
    }
}

#[derive(Deserialize)]
struct MaterialDocument {
    compositions: Vec<MaterialComposition>,
}
#[derive(Deserialize)]
struct MaterialComposition {
    layers: Vec<MaterialLayer>,
}
#[derive(Deserialize)]
struct MaterialLayer {
    kind: String,
    material: Option<OrderedJson>,
    mesh: Option<MaterialMesh>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MaterialMesh {
    source_material: Option<OrderedJson>,
}

impl SceneProject {
    /// File-backed evaluation retains the author's material property order for integer MRT IDs.
    pub fn compile_document(
        bytes: &[u8],
        limits: &SceneLimits,
        evaluation: &EvaluationLimits,
        expressions: &ExpressionLimits,
    ) -> Result<Self, EvaluationError> {
        let document: Project = serde_json::from_slice(bytes)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let identities: MaterialDocument = serde_json::from_slice(bytes)
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let mut compiled = Self::compile(document, limits, evaluation, expressions)?;
        for (composition, source) in compiled
            .compositions
            .iter_mut()
            .zip(identities.compositions)
        {
            for (layer, source) in composition.layers.iter_mut().zip(source.layers) {
                let value = source
                    .material
                    .or_else(|| source.mesh.and_then(|m| m.source_material))
                    .unwrap_or(OrderedJson::String(source.kind));
                let mut key = String::from("material:");
                value.write(&mut key)?;
                layer.material_id = RenderIdentity::encode(&key);
            }
        }
        Ok(compiled)
    }
}

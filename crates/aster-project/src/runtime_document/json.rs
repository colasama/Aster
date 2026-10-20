use serde::{
    Deserialize, Deserializer, Serialize, Serializer,
    de::{MapAccess, Visitor},
    ser::SerializeMap,
};
use serde_json::Number;
use std::{collections::BTreeMap, fmt};

/// Preserve authored object order across runtime upgrades, including render identity inputs.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub(super) enum Json {
    Object(Object),
    Array(Vec<Json>),
    String(String),
    Number(Number),
    Bool(bool),
    Null,
}
#[derive(Clone, Debug, Default)]
pub(super) struct Object(Vec<(String, Json)>);
struct ObjectVisitor;
impl<'de> Deserialize<'de> for Object {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(ObjectVisitor)
    }
}
impl<'de> Visitor<'de> for ObjectVisitor {
    type Value = Object;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("an ordered JSON object")
    }
    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Object, M::Error> {
        let mut result = Object::default();
        let mut indices = BTreeMap::new();
        while let Some((key, value)) = map.next_entry::<String, Json>()? {
            if let Some(index) = indices.get(&key).copied() {
                result.0[index] = (key, value);
            } else {
                indices.insert(key.clone(), result.0.len());
                result.0.push((key, value));
            }
        }
        Ok(result)
    }
}
impl Serialize for Object {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        let mut integers = BTreeMap::new();
        for (key, value) in &self.0 {
            if let Ok(index) = key.parse::<u32>()
                && index < u32::MAX
                && index.to_string() == *key
            {
                integers.insert(index, (key, value));
            }
        }
        for (key, value) in integers.values() {
            map.serialize_entry(key, value)?;
        }
        for (key, value) in &self.0 {
            if key
                .parse::<u32>()
                .is_ok_and(|index| integers.contains_key(&index) && index.to_string() == *key)
            {
                continue;
            }
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}
impl Json {
    pub fn typed(value: &impl Serialize) -> Result<Self, serde_json::Error> {
        let bytes = serde_json::to_vec(value)?;
        serde_json::from_slice(&bytes)
    }
    pub fn object(&self) -> Option<&Object> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }
    pub fn object_mut(&mut self) -> Option<&mut Object> {
        match self {
            Self::Object(value) => Some(value),
            _ => None,
        }
    }
    pub fn array(&self) -> Option<&[Json]> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }
    pub fn array_mut(&mut self) -> Option<&mut Vec<Json>> {
        match self {
            Self::Array(value) => Some(value),
            _ => None,
        }
    }
    pub fn string(&self) -> Option<&str> {
        match self {
            Self::String(value) => Some(value),
            _ => None,
        }
    }
    pub fn finite(&self) -> Option<f64> {
        match self {
            Self::Number(value) => value.as_f64().filter(|v| v.is_finite()),
            _ => None,
        }
    }
    pub fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(value) => *value,
            Self::Number(value) => value.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
            Self::String(value) => !value.is_empty(),
            _ => true,
        }
    }
}
impl Object {
    pub fn get(&self, name: &str) -> Option<&Json> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }
    pub fn get_mut(&mut self, name: &str) -> Option<&mut Json> {
        self.0
            .iter_mut()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }
    pub fn set(&mut self, name: &str, value: Json) {
        if let Some(existing) = self.get_mut(name) {
            *existing = value;
        } else {
            self.0.push((name.to_owned(), value));
        }
    }
    pub fn remove(&mut self, name: &str) -> Option<Json> {
        let index = self.0.iter().position(|(key, _)| key == name)?;
        Some(self.0.remove(index).1)
    }
    pub fn number(&self, name: &str, fallback: f64) -> f64 {
        self.get(name).and_then(Json::finite).unwrap_or(fallback)
    }
    pub fn bounded(&self, name: &str, minimum: f64, maximum: f64, fallback: f64) -> f64 {
        self.number(name, fallback).clamp(minimum, maximum)
    }
}
impl Object {
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(key, _)| key.as_str())
    }
}

use super::{Json, Object, RuntimeProjectDocument};
use crate::ProjectError;
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacySource {
    id: String,
    kind: &'static str,
    name: String,
    mime_type: String,
    content_identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    relative_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_url: Option<String>,
    width: f64,
    height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration: Option<f64>,
    interpretation: Interpretation,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Interpretation {
    alpha: &'static str,
    color_space: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Audio {
    levels_db: [f64; 2],
    pan: f64,
    muted: bool,
    reversed: bool,
}
impl RuntimeProjectDocument {
    pub(super) fn sources(document: &mut Object) -> Result<(), ProjectError> {
        let mut sources: Vec<LegacySource> = Vec::new();
        let mut identities = BTreeMap::<String, usize>::new();
        let mut source_id_counts = BTreeMap::<String, usize>::new();
        let mut assignments = document
            .get("itemFolderIds")
            .and_then(Json::object)
            .cloned()
            .unwrap_or_default();
        for composition in Self::compositions(document) {
            for layer in Self::layers(composition) {
                let Some(asset) = layer.get("asset").and_then(Json::object) else {
                    continue;
                };
                let kind = if layer.get("kind").and_then(Json::string) == Some("video") {
                    "video"
                } else {
                    "still"
                };
                let key = if let Some(value) = asset.get("dataUrl").and_then(Json::string) {
                    value.to_owned()
                } else if let Some(value) = asset.get("relativePath").and_then(Json::string) {
                    format!("{kind}:relative:{value}")
                } else if let Some(value) = asset.get("runtimeUrl").and_then(Json::string) {
                    format!("{kind}:runtime:{value}")
                } else {
                    serde_json::to_string(&(
                        kind,
                        asset.get("mimeType"),
                        asset.get("name"),
                        asset.get("width"),
                        asset.get("height"),
                        asset.get("duration"),
                    ))?
                };
                let index = if let Some(index) = identities.get(&key) {
                    *index
                } else {
                    let mime_type = asset
                        .get("mimeType")
                        .filter(|v| !matches!(v, Json::Null))
                        .map(Json::js_string)
                        .unwrap_or_else(|| "application/octet-stream".into());
                    let width = asset
                        .get("width")
                        .filter(|v| !matches!(v, Json::Null))
                        .map(Json::js_number)
                        .unwrap_or(1.0);
                    let height = asset
                        .get("height")
                        .filter(|v| !matches!(v, Json::Null))
                        .map(Json::js_number)
                        .unwrap_or(1.0);
                    let duration = (kind == "video").then(|| {
                        asset
                            .get("duration")
                            .filter(|v| !matches!(v, Json::Null))
                            .map(Json::js_number)
                            .unwrap_or(0.001)
                    });
                    let data_url = asset
                        .get("dataUrl")
                        .and_then(Json::string)
                        .map(str::to_owned);
                    let relative_path = asset
                        .get("relativePath")
                        .and_then(Json::string)
                        .map(str::to_owned);
                    let runtime_url = asset
                        .get("runtimeUrl")
                        .and_then(Json::string)
                        .map(str::to_owned);
                    let locator = data_url
                        .as_deref()
                        .or(relative_path.as_deref())
                        .or(runtime_url.as_deref())
                        .unwrap_or("missing");
                    let mut left = 0x811c9dc5_u32;
                    let mut right = 0x9e3779b9_u32;
                    let mut length = 0;
                    for part in [
                        mime_type.as_str(),
                        locator,
                        ryu_js::Buffer::new().format(width),
                        ryu_js::Buffer::new().format(height),
                        ryu_js::Buffer::new().format(duration.unwrap_or(0.0)),
                    ] {
                        for code in part.encode_utf16().chain(std::iter::once(0)) {
                            left = (left ^ u32::from(code)).wrapping_mul(0x01000193);
                            right = (right ^ u32::from(code)).wrapping_mul(0x85ebca6b);
                            length += 1;
                        }
                    }
                    let identity = format!("fnv64:{left:08x}{right:08x}:{length}");
                    let base = format!(
                        "source-{}",
                        identity
                            .chars()
                            .filter(char::is_ascii_alphanumeric)
                            .take(32)
                            .collect::<String>()
                    );
                    // Generated bases contain no suffix separator, so each collision sequence is independent.
                    let count = source_id_counts.entry(base.clone()).or_default();
                    *count += 1;
                    let id = if *count == 1 {
                        base
                    } else {
                        format!("{base}-{count}")
                    };
                    let name = asset
                        .get("name")
                        .filter(|v| !matches!(v, Json::Null))
                        .or_else(|| layer.get("name").filter(|v| !matches!(v, Json::Null)))
                        .map(Json::js_string)
                        .unwrap_or_else(|| "Imported footage".into());
                    let index = sources.len();
                    sources.push(LegacySource {
                        id,
                        kind,
                        name,
                        mime_type,
                        content_identity: identity,
                        data_url,
                        relative_path,
                        runtime_url,
                        width,
                        height,
                        duration,
                        interpretation: Interpretation {
                            alpha: "straight",
                            color_space: "srgb",
                        },
                    });
                    identities.insert(key, index);
                    index
                };
                let source_id = &sources[index].id;
                layer.set("sourceId", Json::String(source_id.clone()));
                if let Some(layer_id) = layer
                    .get("id")
                    .and_then(Json::string)
                    .filter(|v| !v.is_empty())
                {
                    if assignments.get(source_id).is_none()
                        && let Some(folder) = assignments.get(layer_id).cloned()
                    {
                        assignments.set(source_id, folder);
                    }
                    assignments.remove(layer_id);
                }
                layer.remove("asset");
            }
        }
        document.set("sources", Json::typed(&sources)?);
        document.set("itemFolderIds", Json::Object(assignments));
        Ok(())
    }
    pub(super) fn audio(document: &mut Object) -> Result<(), ProjectError> {
        if let Some(sources) = document.get_mut("sources").and_then(Json::array_mut) {
            for source in sources.iter_mut().filter_map(Json::object_mut) {
                if source.get("kind").and_then(Json::string) == Some("audio")
                    && source.get("streamIndex").is_none()
                {
                    source.set("streamIndex", Json::typed(&0)?);
                }
            }
        }
        for composition in Self::compositions(document) {
            for layer in Self::layers(composition) {
                if !matches!(
                    layer.get("kind").and_then(Json::string),
                    Some("video" | "audio")
                ) {
                    continue;
                }
                let gain = layer.bounded("audioGain", 0.0, 1.0, 1.0);
                let db = if gain <= 0.0 {
                    -192.0
                } else {
                    20.0 * gain.log10()
                };
                if layer.get("audio").is_none_or(|v| matches!(v, Json::Null)) {
                    layer.set(
                        "audio",
                        Json::typed(&Audio {
                            levels_db: [db; 2],
                            pan: 0.0,
                            muted: matches!(layer.get("audioEnabled"), Some(Json::Bool(false))),
                            reversed: false,
                        })?,
                    );
                }
                layer.remove("audioGain");
            }
        }
        Ok(())
    }
}
impl Json {
    pub(super) fn js_string(&self) -> String {
        match self {
            Self::String(v) => v.clone(),
            Self::Null => "null".into(),
            Self::Bool(v) => v.to_string(),
            Self::Number(v) => ryu_js::Buffer::new()
                .format(v.as_f64().unwrap_or(f64::NAN))
                .to_owned(),
            Self::Object(_) => "[object Object]".into(),
            Self::Array(v) => v
                .iter()
                .map(|v| {
                    if matches!(v, Self::Null) {
                        String::new()
                    } else {
                        v.js_string()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
        }
    }
    pub(super) fn js_number(&self) -> f64 {
        match self {
            Self::Null => 0.0,
            Self::Bool(v) => f64::from(*v),
            Self::Number(v) => v.as_f64().unwrap_or(f64::NAN),
            Self::String(_) | Self::Array(_) => {
                let text = self.js_string();
                let text = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
                if text.is_empty() {
                    return 0.0;
                }
                for (prefix, radix) in [
                    ("0x", 16),
                    ("0X", 16),
                    ("0b", 2),
                    ("0B", 2),
                    ("0o", 8),
                    ("0O", 8),
                ] {
                    if let Some(digits) = text.strip_prefix(prefix) {
                        return if digits.is_empty() {
                            f64::NAN
                        } else {
                            digits
                                .chars()
                                .try_fold(0.0, |value, c| {
                                    c.to_digit(radix)
                                        .map(|d| value * f64::from(radix) + f64::from(d))
                                })
                                .unwrap_or(f64::NAN)
                        };
                    }
                }
                if matches!(text, "Infinity" | "+Infinity") {
                    f64::INFINITY
                } else if text == "-Infinity" {
                    f64::NEG_INFINITY
                } else if text
                    .chars()
                    .all(|c| c.is_ascii_digit() || matches!(c, '.' | '+' | '-' | 'e' | 'E'))
                {
                    text.parse().unwrap_or(f64::NAN)
                } else {
                    f64::NAN
                }
            }
            Self::Object(_) => f64::NAN,
        }
    }
}

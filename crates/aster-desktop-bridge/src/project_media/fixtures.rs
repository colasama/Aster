use super::{Value, media_file::Fnv64State};
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaFixture {
    schema_version: u64,
    active_composition_id: String,
    compositions: Vec<CompositionFixture>,
    media_imports: ImportsFixture,
}

#[derive(Serialize)]
struct CompositionFixture {
    id: String,
    layers: Vec<Value>,
}

#[derive(Serialize)]
struct ImportsFixture {
    version: u64,
    entries: Vec<EntryFixture>,
    payloads: Vec<PayloadFixture>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EntryFixture {
    pub source_id: String,
    pub kind: String,
    pub content_identity: String,
    pub payload_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub import_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer_key: Option<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PayloadFixture {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document_identity: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage: Option<StorageFixture>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames: Option<Vec<FrameFixture>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FrameFixture {
    pub frame: u32,
    pub name: String,
    pub size: u64,
    pub last_modified: u64,
    #[serde(rename = "type")]
    pub media_type: String,
    pub storage: StorageFixture,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(super) enum StorageFixture {
    Inline {
        byte_identity: String,
        data: String,
    },
    External {
        external_path: PathBuf,
        #[serde(skip_serializing_if = "Option::is_none")]
        byte_identity: Option<String>,
    },
    Relative {
        relative_path: String,
        byte_identity: String,
    },
}

impl MediaFixture {
    pub(super) fn document(
        payload: PayloadFixture,
        entries: Vec<EntryFixture>,
    ) -> Result<Value, serde_json::Error> {
        serde_json::to_value(Self {
            schema_version: 11,
            active_composition_id: "main".into(),
            compositions: vec![CompositionFixture {
                id: "main".into(),
                layers: Vec::new(),
            }],
            media_imports: ImportsFixture {
                version: 1,
                entries,
                payloads: vec![payload],
            },
        })
    }

    pub(super) fn inline_svg(bytes: &[u8]) -> Result<Value, serde_json::Error> {
        let identity = Fnv64State::bytes_identity(bytes);
        let payload_id = format!("svg:{identity}");
        Self::document(
            PayloadFixture {
                id: payload_id.clone(),
                kind: "svg".into(),
                content_identity: Some(identity.clone()),
                width: Some(10),
                height: Some(10),
                storage: Some(StorageFixture::Inline {
                    byte_identity: identity.clone(),
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                }),
                ..Default::default()
            },
            vec![EntryFixture {
                source_id: "svg-source".into(),
                kind: "svg".into(),
                content_identity: identity,
                payload_id,
                ..Default::default()
            }],
        )
    }

    pub(super) fn external_svg(bytes: &[u8], path: &Path) -> Result<Value, serde_json::Error> {
        let mut project = Self::inline_svg(bytes)?;
        project["mediaImports"]["payloads"][0]["storage"] =
            serde_json::to_value(StorageFixture::External {
                external_path: path.to_owned(),
                byte_identity: Some(Fnv64State::bytes_identity(bytes)),
            })?;
        Ok(project)
    }

    pub(super) fn inline_footage(
        bytes: &[u8],
        kind: &str,
        extension: &str,
    ) -> Result<Value, serde_json::Error> {
        let identity = Fnv64State::bytes_identity(bytes);
        let content_identity = format!("sha256:{:x}", Sha256::digest(bytes));
        Self::document(
            PayloadFixture {
                id: "footage:payload".into(),
                kind: kind.into(),
                content_identity: Some(content_identity.clone()),
                mime_type: Some(
                    if kind == "audio" {
                        "audio/wav"
                    } else {
                        "video/mp4"
                    }
                    .into(),
                ),
                extension: Some(extension.into()),
                storage: Some(StorageFixture::Inline {
                    byte_identity: identity,
                    data: base64::engine::general_purpose::STANDARD.encode(bytes),
                }),
                ..Default::default()
            },
            vec![EntryFixture {
                source_id: "footage-source".into(),
                kind: kind.into(),
                content_identity,
                payload_id: "footage:payload".into(),
                ..Default::default()
            }],
        )
    }
}

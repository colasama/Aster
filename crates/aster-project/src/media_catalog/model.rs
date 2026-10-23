use crate::ProjectMediaStorage;
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FootagePayload {
    pub id: String,
    pub content_identity: String,
    pub mime_type: String,
    pub storage: ProjectMediaStorage,
    #[serde(default)]
    pub legacy_locator: Option<super::legacy::LegacyMediaLocator>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SvgPayload {
    pub id: String,
    pub content_identity: String,
    pub width: u32,
    pub height: u32,
    pub storage: ProjectMediaStorage,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PsdPayload {
    pub id: String,
    pub document_identity: String,
    pub storage: ProjectMediaStorage,
}

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectMediaPayload {
    Still(FootagePayload),
    Video(FootagePayload),
    Audio(FootagePayload),
    Svg(SvgPayload),
    Psd(PsdPayload),
    ImageSequence(super::ProjectSequence),
}

impl ProjectMediaPayload {
    pub fn identity(&self) -> (&str, &str, &str) {
        match self {
            Self::Still(p) => (&p.id, "still", &p.content_identity),
            Self::Video(p) => (&p.id, "video", &p.content_identity),
            Self::Audio(p) => (&p.id, "audio", &p.content_identity),
            Self::Svg(p) => (&p.id, "svg", &p.content_identity),
            Self::Psd(p) => (&p.id, "psd", &p.document_identity),
            Self::ImageSequence(p) => (&p.id, "imageSequence", &p.content_identity),
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub source_id: String,
    pub kind: String,
    pub content_identity: String,
    pub payload_id: String,
    pub document_identity: Option<String>,
    pub import_mode: Option<String>,
    pub layer_key: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct Imports {
    pub version: u32,
    pub entries: Vec<MediaEntry>,
    pub payloads: Vec<ProjectMediaPayload>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Document {
    #[serde(default)]
    pub sources: Vec<aster_types::editor::Source>,
    pub media_imports: Option<Imports>,
}

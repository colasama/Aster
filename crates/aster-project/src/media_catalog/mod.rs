mod model;
mod sequence;
use crate::{MediaSourceReader, MediaSourceSnapshot, ProjectError};
use aster_types::editor::Source;
use model::Document;
pub use model::{FootagePayload, MediaEntry, ProjectMediaPayload, PsdPayload, SvgPayload};
pub use sequence::{
    MissingSequenceFrame, ProjectSequence, ProjectSequenceFrame, SequenceRate, SequenceSelection,
};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Debug, clap::Args)]
pub struct ProjectMediaCatalogLimits {
    #[arg(long, default_value_t = Self::default().media_catalog_input_bytes)]
    pub media_catalog_input_bytes: usize,
    #[arg(long, default_value_t = Self::default().media_catalog_entries)]
    pub media_catalog_entries: usize,
    #[arg(long, default_value_t = Self::default().media_sequence_frames)]
    pub media_sequence_frames: usize,
}

impl Default for ProjectMediaCatalogLimits {
    fn default() -> Self {
        Self {
            media_catalog_input_bytes: 67_108_864,
            media_catalog_entries: 50_000,
            media_sequence_frames: 4096,
        }
    }
}

pub struct ProjectMediaCatalog {
    sources: BTreeMap<String, Arc<Source>>,
    entries: BTreeMap<String, MediaEntry>,
    payloads: BTreeMap<String, Arc<ProjectMediaPayload>>,
}

#[derive(Clone)]
pub struct ProjectMediaBinding {
    pub source: Arc<Source>,
    pub entry: Option<MediaEntry>,
    pub payload: Option<Arc<ProjectMediaPayload>>,
}

impl ProjectMediaCatalog {
    pub fn from_slice(
        bytes: &[u8],
        limits: &ProjectMediaCatalogLimits,
    ) -> Result<Self, ProjectError> {
        if bytes.len() > limits.media_catalog_input_bytes
            || limits.media_catalog_entries == 0
            || limits.media_sequence_frames == 0
        {
            return Err(ProjectError::InvalidMedia(
                "media catalog admission budget exceeded",
            ));
        }
        let document: Document = serde_json::from_slice(bytes)?;
        if document.sources.len() > limits.media_catalog_entries {
            return Err(ProjectError::InvalidMedia(
                "media source count exceeds budget",
            ));
        }
        let mut catalog = Self {
            sources: BTreeMap::new(),
            entries: BTreeMap::new(),
            payloads: BTreeMap::new(),
        };
        for source in document.sources {
            if source.id.is_empty()
                || source.id.encode_utf16().count() > 512
                || catalog
                    .sources
                    .insert(source.id.clone(), Arc::new(source))
                    .is_some()
            {
                return Err(ProjectError::InvalidMedia(
                    "media source identifiers must be bounded and unique",
                ));
            }
        }
        if let Some(imports) = document.media_imports {
            if imports.version != 1
                || imports.entries.len() > limits.media_catalog_entries
                || imports.payloads.len() > limits.media_catalog_entries
            {
                return Err(ProjectError::InvalidMedia(
                    "unsupported media sidecar or entry budget",
                ));
            }
            for mut payload in imports.payloads {
                if let ProjectMediaPayload::ImageSequence(sequence) = &mut payload {
                    sequence.validate(limits.media_sequence_frames)?;
                }
                let (id, _, identity) = payload.identity();
                if id.is_empty()
                    || id.encode_utf16().count() > 512
                    || identity.is_empty()
                    || identity.encode_utf16().count() > 512
                {
                    return Err(ProjectError::InvalidMedia(
                        "bounded payload identities required",
                    ));
                }
                if catalog
                    .payloads
                    .insert(id.to_owned(), Arc::new(payload))
                    .is_some()
                {
                    return Err(ProjectError::InvalidMedia(
                        "duplicate media payload identifier",
                    ));
                }
            }
            for entry in imports.entries {
                let source = catalog
                    .sources
                    .get(&entry.source_id)
                    .ok_or(ProjectError::InvalidMedia("media entry source is missing"))?;
                let payload = catalog
                    .payloads
                    .get(&entry.payload_id)
                    .ok_or(ProjectError::InvalidMedia("media entry payload is missing"))?;
                let (_, kind, identity) = payload.identity();
                if source.kind != entry.kind
                    || kind != entry.kind
                    || source.content_identity != entry.content_identity
                {
                    return Err(ProjectError::InvalidMedia(
                        "media entry source or payload identity differs",
                    ));
                }
                match payload.as_ref() {
                    ProjectMediaPayload::Psd(p) => {
                        let mode = entry
                            .import_mode
                            .as_deref()
                            .ok_or(ProjectError::InvalidMedia("PSD import mode absent"))?;
                        let key = entry
                            .layer_key
                            .as_deref()
                            .filter(|s| !s.is_empty())
                            .ok_or(ProjectError::InvalidMedia("PSD layer key absent"))?;
                        if !matches!(
                            mode,
                            "merged" | "composition" | "compositionRetainLayerSizes"
                        ) || entry.document_identity.as_deref() != Some(&p.document_identity)
                            || source.content_identity
                                != format!("{}:{mode}:{key}", p.document_identity)
                        {
                            return Err(ProjectError::InvalidMedia("PSD source identity differs"));
                        }
                    }
                    _ if source.content_identity != identity => {
                        return Err(ProjectError::InvalidMedia(
                            "source content identity differs from payload",
                        ));
                    }
                    ProjectMediaPayload::Still(p)
                    | ProjectMediaPayload::Video(p)
                    | ProjectMediaPayload::Audio(p)
                        if p.mime_type != source.mime_type =>
                    {
                        return Err(ProjectError::InvalidMedia(
                            "source MIME type differs from payload",
                        ));
                    }
                    ProjectMediaPayload::Svg(p)
                        if source.width.value().and_then(|n| n.as_f64())
                            != Some(f64::from(p.width))
                            || source.height.value().and_then(|n| n.as_f64())
                                != Some(f64::from(p.height)) =>
                    {
                        return Err(ProjectError::InvalidMedia("SVG source dimensions differ"));
                    }
                    ProjectMediaPayload::ImageSequence(p)
                        if source.pattern.value() != Some(&p.pattern)
                            || source.start_frame.value().and_then(|n| n.as_f64())
                                != Some(p.start_frame as f64)
                            || source.end_frame.value().and_then(|n| n.as_f64())
                                != Some(p.end_frame as f64) =>
                    {
                        return Err(ProjectError::InvalidMedia("sequence source bounds differ"));
                    }
                    _ => {}
                }
                if catalog
                    .entries
                    .insert(entry.source_id.clone(), entry)
                    .is_some()
                {
                    return Err(ProjectError::InvalidMedia("duplicate media source binding"));
                }
            }
        }
        Ok(catalog)
    }

    pub fn bind(&self, source_id: &str) -> Result<ProjectMediaBinding, ProjectError> {
        let source = self
            .sources
            .get(source_id)
            .ok_or(ProjectError::InvalidMedia("unknown project media source"))?;
        let entry = self.entries.get(source_id).cloned();
        let payload = entry
            .as_ref()
            .and_then(|e| self.payloads.get(&e.payload_id))
            .cloned();
        if payload.is_none() && matches!(source.kind.as_str(), "svg" | "psd" | "imageSequence") {
            return Err(ProjectError::InvalidMedia(
                "advanced source payload is absent",
            ));
        }
        Ok(ProjectMediaBinding {
            source: source.clone(),
            entry,
            payload,
        })
    }
}

impl ProjectMediaBinding {
    pub fn read(
        &self,
        reader: &mut MediaSourceReader,
        frame: Option<i64>,
        max_bytes: u64,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        let (storage, identity) = match self.payload.as_deref() {
            Some(
                ProjectMediaPayload::Still(p)
                | ProjectMediaPayload::Video(p)
                | ProjectMediaPayload::Audio(p),
            ) => (&p.storage, Some(p.content_identity.as_str())),
            Some(ProjectMediaPayload::Svg(p)) => (&p.storage, Some(p.content_identity.as_str())),
            Some(ProjectMediaPayload::Psd(p)) => (&p.storage, Some(p.document_identity.as_str())),
            Some(ProjectMediaPayload::ImageSequence(p)) => {
                let frame =
                    frame.ok_or(ProjectError::InvalidMedia("sequence member is required"))?;
                let member = p
                    .frames
                    .binary_search_by_key(&frame, |f| f.frame)
                    .ok()
                    .and_then(|i| p.frames.get(i))
                    .ok_or(ProjectError::InvalidMedia(
                        "sequence member is not admitted",
                    ))?;
                let snapshot = reader.read(&member.storage, None, max_bytes)?;
                if snapshot.bytes.len() as u64 != member.size {
                    return Err(ProjectError::InvalidMedia("sequence member size differs"));
                }
                return Ok(snapshot);
            }
            None => {
                if frame.is_some() {
                    return Err(ProjectError::InvalidMedia(
                        "ordinary source cannot authorize a sequence member",
                    ));
                }
                let path = self
                    .source
                    .relative_path
                    .value()
                    .ok_or(ProjectError::InvalidMedia(
                        "source has no saved bundle locator",
                    ))?;
                return reader.read_relative_source(path, &self.source.content_identity, max_bytes);
            }
        };
        if frame.is_some() {
            return Err(ProjectError::InvalidMedia(
                "ordinary payload cannot authorize a sequence member",
            ));
        }
        reader.read(storage, identity, max_bytes)
    }
}

#[cfg(test)]
mod tests;

use std::sync::Arc;

use aster_types::editor::ProjectFont;
use sha2::{Digest, Sha256};

use crate::{
    FontCatalog, FontCatalogConfig, FontCatalogError, FontFaceId, FontFaceMetadata, FontId,
    FontRequest, FontSelection, FontStyle, LoadedFont, ProjectFontConfig,
    project_font_input::ProjectFontInput, woff::WoffDecoder,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectFontFallback {
    /// The retained provider must decode and validate these opaque bytes before rendering.
    Woff2DecoderUnavailable,
    EmbeddedCollectionSelectionUnverified,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ProjectFontResolution {
    Native {
        font_id: String,
        revision: [u8; 32],
        selection: FontSelection,
    },
    RetainedRaster {
        font_id: String,
        revision: [u8; 32],
        reason: ProjectFontFallback,
    },
    Platform(FontSelection),
    Missing,
}

struct EmbeddedFace {
    id: String,
    family_key: String,
    range: [f32; 2],
    face: Result<FontFaceId, ProjectFontFallback>,
}

/// Immutable collections are built completely before replacing the active font set.
pub struct ProjectFontSet {
    config: ProjectFontConfig,
    catalog: FontCatalog,
    faces: Vec<EmbeddedFace>,
    revision: [u8; 32],
}

impl ProjectFontSet {
    pub fn new(config: ProjectFontConfig) -> Result<Self, FontCatalogError> {
        Self::build(config, &[])
    }

    pub fn replace(&mut self, fonts: &[ProjectFont]) -> Result<bool, FontCatalogError> {
        let pending = Self::build(self.config.clone(), fonts)?;
        if pending.revision == self.revision {
            return Ok(false);
        }
        *self = pending;
        Ok(true)
    }

    pub fn revision(&self) -> [u8; 32] {
        self.revision
    }

    pub fn face(&self, id: FontFaceId) -> Option<(&FontFaceMetadata, LoadedFont)> {
        self.catalog.face(id)
    }

    fn build(config: ProjectFontConfig, fonts: &[ProjectFont]) -> Result<Self, FontCatalogError> {
        let inputs = ProjectFontInput::validate(fonts, &config)?;
        let mut catalog = FontCatalog::new(FontCatalogConfig {
            max_catalog_bytes: config.max_decoded_project_font_bytes as u64,
            max_catalog_faces: config.max_project_fonts.min(32),
            ..Default::default()
        })?;
        let mut revision = Sha256::new();
        revision.update(b"aster-project-fonts-v1");
        let mut faces = Vec::with_capacity(inputs.len());
        let mut decoded_bytes = 0_usize;
        for input in inputs {
            let family_key = FontFaceMetadata::family_key(&input.family, 160)?;
            for bytes in [input.id.as_bytes(), input.family.as_bytes(), &input.bytes] {
                revision.update((bytes.len() as u64).to_le_bytes());
                revision.update(bytes);
            }
            for weight in input.range {
                revision.update(weight.to_le_bytes());
            }
            revision.update(input.weight.to_le_bytes());
            let face = if input.bytes.starts_with(b"wOF2") {
                Err(ProjectFontFallback::Woff2DecoderUnavailable)
            } else {
                let remaining = config
                    .max_decoded_project_font_bytes
                    .saturating_sub(decoded_bytes);
                let data = if input.bytes.starts_with(b"wOFF") {
                    WoffDecoder::decode(&input.bytes, remaining, config.max_project_font_tables)?
                } else {
                    if input.bytes.len() > remaining {
                        return Err(FontCatalogError::Limit("decoded project font bytes"));
                    }
                    input.bytes
                };
                decoded_bytes += data.len();
                let collection = data.starts_with(b"ttcf");
                let sha256: [u8; 32] = Sha256::digest(&data).into();
                let mut prefix = [0; 8];
                prefix.copy_from_slice(&sha256[..8]);
                let ids = catalog.insert(LoadedFont {
                    id: FontId(u64::from_le_bytes(prefix)),
                    sha256,
                    data: Arc::from(data),
                })?;
                if collection {
                    Err(ProjectFontFallback::EmbeddedCollectionSelectionUnverified)
                } else {
                    Ok(*ids
                        .first()
                        .ok_or(FontCatalogError::Invalid("embedded font has no face"))?)
                }
            };
            faces.push(EmbeddedFace {
                id: input.id,
                family_key,
                range: input.range,
                face,
            });
        }
        Ok(Self {
            config,
            catalog,
            faces,
            revision: revision.finalize().into(),
        })
    }

    pub fn resolve(
        &self,
        request: &FontRequest,
        platform: &FontCatalog,
    ) -> Result<ProjectFontResolution, FontCatalogError> {
        // Validate the complete request even when a project face wins before the platform lookup.
        if !request.weight.is_finite()
            || !(1.0..=1000.0).contains(&request.weight)
            || !request.width_percent.is_finite()
            || request.width_percent <= 0.0
            || request.families.len() > self.catalog.config.max_name_records
        {
            return Err(FontCatalogError::Invalid("invalid project font request"));
        }
        for family in &request.families {
            let key = FontFaceMetadata::family_key(family, self.catalog.config.max_name_chars)?;
            let candidate = self
                .faces
                .iter()
                .enumerate()
                .filter(|(_, face)| face.family_key == key)
                .min_by_key(|(index, face)| {
                    let descriptor = FontSelection {
                        face: FontFaceId {
                            sha256: [0; 32],
                            index: 0,
                        },
                        family: family.clone(),
                        weight: request.weight.clamp(face.range[0], face.range[1]),
                        width_percent: 100.0,
                        style: FontStyle::Normal,
                        variations: Default::default(),
                    };
                    (descriptor.rank(request), std::cmp::Reverse(*index))
                });
            if let Some((_, face)) = candidate {
                return match face.face {
                    Err(reason) => Ok(ProjectFontResolution::RetainedRaster {
                        font_id: face.id.clone(),
                        revision: self.revision,
                        reason,
                    }),
                    Ok(id) => {
                        let (metadata, _) = self
                            .catalog
                            .face(id)
                            .ok_or(FontCatalogError::Invalid("embedded face disappeared"))?;
                        let declared = FontRequest {
                            families: vec![family.clone()],
                            weight: request.weight.clamp(face.range[0], face.range[1]),
                            width_percent: 100.0,
                            style: FontStyle::Normal,
                        };
                        let mut selection = FontSelection::for_face(metadata, family, &declared);
                        // FontFace descriptors, not the source's internal names/style, define this alias.
                        selection.style = FontStyle::Normal;
                        Ok(ProjectFontResolution::Native {
                            font_id: face.id.clone(),
                            revision: self.revision,
                            selection,
                        })
                    }
                };
            }
            let single = FontRequest {
                families: vec![family.clone()],
                ..request.clone()
            };
            if let Some(selection) = platform.select(&single)? {
                return Ok(ProjectFontResolution::Platform(selection));
            }
        }
        Ok(ProjectFontResolution::Missing)
    }
}

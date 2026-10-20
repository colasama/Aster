use std::collections::BTreeMap;

use read_fonts::FileRef;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::{FontFaceId, FontFaceMetadata, LoadedFont};

#[derive(Clone, Debug, clap::Args)]
pub struct FontCatalogConfig {
    #[arg(long, default_value_t = Self::default().max_catalog_faces)]
    pub max_catalog_faces: usize,
    #[arg(long, default_value_t = Self::default().max_catalog_bytes)]
    pub max_catalog_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_catalog_family_names)]
    pub max_catalog_family_names: usize,
    #[arg(long, default_value_t = Self::default().max_name_records)]
    pub max_name_records: usize,
    #[arg(long, default_value_t = Self::default().max_name_chars)]
    pub max_name_chars: usize,
    #[arg(long, default_value_t = Self::default().max_axes)]
    pub max_axes: usize,
}

impl Default for FontCatalogConfig {
    fn default() -> Self {
        Self {
            max_catalog_faces: 8192,
            max_catalog_bytes: 256 * 1024 * 1024,
            max_catalog_family_names: 16_384,
            max_name_records: 4096,
            max_name_chars: 512,
            max_axes: 64,
        }
    }
}

#[derive(Debug, Error)]
pub enum FontCatalogError {
    #[error("font catalog limit exceeded: {0}")]
    Limit(&'static str),
    #[error("invalid font catalog input: {0}")]
    Invalid(&'static str),
    #[error("unsupported font container; decode it before catalog admission")]
    UnsupportedContainer,
    #[error(transparent)]
    Read(#[from] read_fonts::ReadError),
}

/// Owns authenticated font bytes; a collection is admitted atomically with all of its faces.
pub struct FontCatalog {
    pub(crate) config: FontCatalogConfig,
    pub(crate) faces: BTreeMap<FontFaceId, FontFaceMetadata>,
    fonts: BTreeMap<[u8; 32], LoadedFont>,
    bytes: u64,
    family_names: usize,
}

impl FontCatalog {
    pub fn new(config: FontCatalogConfig) -> Result<Self, FontCatalogError> {
        if config.max_catalog_faces == 0
            || config.max_catalog_bytes == 0
            || config.max_catalog_family_names == 0
            || config.max_name_records == 0
            || config.max_name_chars == 0
            || config.max_axes == 0
        {
            return Err(FontCatalogError::Invalid("catalog limits must be nonzero"));
        }
        Ok(Self {
            config,
            faces: BTreeMap::new(),
            fonts: BTreeMap::new(),
            bytes: 0,
            family_names: 0,
        })
    }

    pub fn insert(&mut self, loaded: LoadedFont) -> Result<Vec<FontFaceId>, FontCatalogError> {
        if loaded.data.is_empty() || loaded.data.len() as u64 > self.config.max_catalog_bytes {
            return Err(FontCatalogError::Limit("font bytes"));
        }
        let digest: [u8; 32] = Sha256::digest(&loaded.data).into();
        if digest != loaded.sha256 {
            return Err(FontCatalogError::Invalid("font content hash differs"));
        }
        if self.fonts.contains_key(&digest) {
            return Ok(self
                .faces
                .keys()
                .filter(|id| id.sha256 == digest)
                .copied()
                .collect());
        }
        if loaded.data.len() as u64 > self.config.max_catalog_bytes.saturating_sub(self.bytes) {
            return Err(FontCatalogError::Limit("font bytes"));
        }
        if loaded.data.starts_with(b"wOFF") || loaded.data.starts_with(b"wOF2") {
            return Err(FontCatalogError::UnsupportedContainer);
        }
        let file = FileRef::new(&loaded.data)?;
        let count = match &file {
            FileRef::Font(_) => 1,
            FileRef::Collection(collection) => collection.len() as usize,
        };
        if count == 0
            || count
                > self
                    .config
                    .max_catalog_faces
                    .saturating_sub(self.faces.len())
        {
            return Err(FontCatalogError::Limit("font faces"));
        }
        let mut pending = BTreeMap::new();
        let mut family_names = self.family_names;
        for (index, font) in file.fonts().enumerate() {
            let id = FontFaceId {
                sha256: digest,
                index: u32::try_from(index).map_err(|_| FontCatalogError::Limit("face index"))?,
            };
            let face = FontFaceMetadata::read(font?, id, &self.config)?;
            family_names = family_names
                .checked_add(face.families.len())
                .filter(|count| *count <= self.config.max_catalog_family_names)
                .ok_or(FontCatalogError::Limit("catalog family names"))?;
            pending.insert(id, face);
        }
        let ids = pending.keys().copied().collect();
        self.bytes += loaded.data.len() as u64;
        self.family_names = family_names;
        self.fonts.insert(digest, loaded);
        self.faces.append(&mut pending);
        Ok(ids)
    }

    pub fn face(&self, id: FontFaceId) -> Option<(&FontFaceMetadata, LoadedFont)> {
        let face = self.faces.get(&id)?;
        let font = self.fonts.get(&id.sha256)?.clone();
        Some((face, font))
    }

    pub fn remove(&mut self, digest: [u8; 32]) -> bool {
        let Some(font) = self.fonts.remove(&digest) else {
            return false;
        };
        self.bytes -= font.data.len() as u64;
        self.faces.retain(|id, face| {
            if id.sha256 != digest {
                true
            } else {
                self.family_names -= face.families.len();
                false
            }
        });
        true
    }

    #[must_use]
    pub fn statistics(&self) -> (usize, usize, u64) {
        (self.fonts.len(), self.faces.len(), self.bytes)
    }
}

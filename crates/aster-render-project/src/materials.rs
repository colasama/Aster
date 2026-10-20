use crate::{NativeProjectDocument, ProjectRenderError};
use aster_eval::{BundleResources, MaterialResources};
use aster_media_native::{
    NativeTextureSession, RadianceEnvironment, RadianceLimits, TextureLimits,
};
use aster_render_ir::{
    EncodedTextureDescriptor, ResourceDescriptor, ResourceHash, ResourceKind, ResourceLimits,
    ResourceRegistry, TextureColorConversion, TextureDimension, TextureEncoding,
    TexturePixelFormat, TexturePixelsDescriptor, VerifiedResource,
};
use aster_video::CancellationToken;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
};

pub struct DecodedMaterialPixels {
    pub encoded: ResourceHash,
    pub pixels: VerifiedResource,
}
pub struct ProjectMaterialFrame {
    pub bindings: MaterialResources,
    pub resources: Vec<VerifiedResource>,
    pub decoded: Vec<DecodedMaterialPixels>,
}

pub struct NativeProjectMaterials {
    textures: NativeTextureSession,
    radiance: RadianceLimits,
    encoded: BTreeMap<String, VerifiedResource>,
    environment: Option<(String, VerifiedResource)>,
}

impl NativeProjectMaterials {
    pub fn new(
        ffmpeg: PathBuf,
        textures: TextureLimits,
        radiance: RadianceLimits,
    ) -> Result<Self, ProjectRenderError> {
        Ok(Self {
            textures: NativeTextureSession::new(ffmpeg, textures)?,
            radiance,
            encoded: BTreeMap::new(),
            environment: None,
        })
    }

    /// Acquires authenticated CPU resources. GPU realization is separate and must succeed before planning.
    pub fn acquire(
        &mut self,
        document: &NativeProjectDocument,
        composition: &str,
        time: f64,
        cancellation: &CancellationToken,
    ) -> Result<ProjectMaterialFrame, ProjectRenderError> {
        if cancellation.is_cancelled() {
            return Err(
                aster_media_native::MediaError::from(aster_video::FfmpegError::Cancelled).into(),
            );
        }
        let sources = document.scene.material_texture_sources(composition, time)?;
        let mut bindings = MaterialResources::default();
        let mut resources = BTreeMap::new();
        let mut decoded = BTreeMap::new();
        let mut budget = BundleResources::new(document.limits.bundle.clone())?;
        let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
        let mut active = BTreeSet::new();
        for (instance, source) in sources.normals {
            let key = format!("{:x}", Sha256::digest(source.as_bytes()));
            active.insert(key.clone());
            let resource = if let Some(resource) = self.encoded.get(&key) {
                resource.clone()
            } else {
                let bytes = Self::inline(&source)?;
                let encoding = if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
                    TextureEncoding::Png
                } else if bytes.starts_with(&[255, 216, 255]) {
                    TextureEncoding::Jpeg
                } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                    TextureEncoding::Webp
                } else {
                    return Err(ProjectRenderError::Invalid(
                        "unsupported inline normal encoding".into(),
                    ));
                };
                VerifiedResource::new(
                    ResourceKind::EncodedTexture,
                    ResourceDescriptor::EncodedTexture(EncodedTextureDescriptor {
                        encoding,
                        format: TexturePixelFormat::Rgba8Unorm,
                        color_space_conversion: TextureColorConversion::None,
                    }),
                    bytes,
                )?
            };
            budget.add(resource.clone())?;
            let hash = resource.request().hash.clone();
            if !decoded.contains_key(&hash) {
                registry.put_verified(resource.clone())?;
                let image = self.textures.decode(&hash, &registry, cancellation)?;
                let pixels = VerifiedResource::new(
                    ResourceKind::TexturePixels,
                    ResourceDescriptor::TexturePixels(TexturePixelsDescriptor {
                        dimension: TextureDimension::D2,
                        width: image.receipt.width,
                        height: image.receipt.height,
                        depth: 1,
                        format: TexturePixelFormat::Rgba8Unorm,
                    }),
                    image.bytes.to_vec(),
                )?;
                budget.add(pixels.clone())?;
                decoded.insert(
                    hash.clone(),
                    DecodedMaterialPixels {
                        encoded: hash.clone(),
                        pixels,
                    },
                );
            }
            self.encoded.insert(key, resource.clone());
            bindings.normals.insert(instance, hash.clone());
            resources.insert(hash, resource);
        }
        self.encoded.retain(|key, _| active.contains(key));
        if let Some(source) = sources.environment {
            let key = format!("{:x}", Sha256::digest(source.as_bytes()));
            let resource = if let Some((previous, resource)) = &self.environment
                && previous == &key
            {
                resource.clone()
            } else {
                RadianceEnvironment::decode(Self::inline(&source)?, &self.radiance, cancellation)?
            };
            budget.add(resource.clone())?;
            bindings.environment = Some(resource.request().hash.clone());
            resources.insert(resource.request().hash.clone(), resource.clone());
            self.environment = Some((key, resource));
        } else {
            self.environment = None;
        }
        Ok(ProjectMaterialFrame {
            bindings,
            resources: resources.into_values().collect(),
            decoded: decoded.into_values().collect(),
        })
    }

    fn inline(source: &str) -> Result<Vec<u8>, ProjectRenderError> {
        if source.len() > 64 * 1024 * 1024 {
            return Err(ProjectRenderError::Invalid(
                "material data URL exceeds byte budget".into(),
            ));
        }
        let (header, payload) = source
            .split_once(',')
            .filter(|(h, _)| h.starts_with("data:"))
            .ok_or_else(|| {
                ProjectRenderError::Invalid("inline material data URL required".into())
            })?;
        if header.ends_with(";base64") {
            return base64::engine::general_purpose::STANDARD
                .decode(payload)
                .map_err(|_| ProjectRenderError::Invalid("invalid material base64".into()));
        }
        let mut bytes = Vec::with_capacity(payload.len());
        let mut index = 0;
        while index < payload.len() {
            if payload.as_bytes()[index] == b'%' {
                let digits = payload.get(index + 1..index + 3).ok_or_else(|| {
                    ProjectRenderError::Invalid("truncated material percent escape".into())
                })?;
                bytes.push(u8::from_str_radix(digits, 16).map_err(|_| {
                    ProjectRenderError::Invalid("invalid material percent escape".into())
                })?);
                index += 3;
            } else {
                bytes.push(payload.as_bytes()[index]);
                index += 1;
            }
        }
        Ok(bytes)
    }
}

use crate::{ProjectRasterFrame, ProjectRenderError, ProjectRenderLimits};
use aster_eval::{
    BundleMediaPixels, ProjectResourceRequests, TemporalRasterPass, TextGeometryBounds,
};
use aster_render_ir::{ResourceDescriptor, ResourceHash, ResourceMessage, VerifiedResource};
use aster_video::CancellationToken;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs::File, io::Read, path::Path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RasterManifest {
    #[serde(rename = "caseId")]
    _case_id: String,
    #[serde(rename = "index")]
    _index: usize,
    request_sha256: String,
    bindings: BTreeMap<String, Option<ResourceHash>>,
    resources: Vec<RasterResourceMessage>,
    pixels: Vec<RasterPayload>,
    temporal: Vec<TemporalRasterPass>,
    text_bounds: BTreeMap<String, TextGeometryBounds>,
    previous_text_bounds: BTreeMap<String, TextGeometryBounds>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RasterPayload {
    frame: ResourceMessage,
    message: ResourceMessage,
    file: String,
    sha256: String,
}

/// Process-local immutable proofs, never reconstructed from wire-provided hashes.
pub(crate) struct RasterPayloadCache {
    pub budget_bytes: usize,
    pub entries: BTreeMap<String, (VerifiedResource, String)>,
    pub resources: BTreeMap<ResourceHash, (VerifiedResource, usize)>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RasterResourceMessage {
    Complete(ResourceMessage),
    Resident(ResidentRasterResource),
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ResidentRasterResource {
    ResidentResource { hash: ResourceHash },
}

impl RasterResourceMessage {
    fn verify(
        self,
        cache: Option<&RasterPayloadCache>,
    ) -> Result<(VerifiedResource, usize), ProjectRenderError> {
        match self {
            Self::Complete(message) => {
                let resource = RasterManifest::verify(message, Vec::new())?;
                let bytes = serde_json::to_vec(resource.request())?.len();
                Ok((resource, bytes))
            }
            Self::Resident(ResidentRasterResource::ResidentResource { hash }) => {
                hash.validate()?;
                cache
                    .and_then(|cache| cache.resources.get(&hash))
                    .cloned()
                    .ok_or_else(|| {
                        ProjectRenderError::Invalid("raster descriptor is not resident".into())
                    })
            }
        }
    }
}

impl RasterManifest {
    fn read(path: &Path, maximum: usize) -> Result<Vec<u8>, ProjectRenderError> {
        let file = File::open(path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.len() > maximum as u64 {
            return Err(ProjectRenderError::Invalid(
                "raster file exceeds byte budget".into(),
            ));
        }
        let mut bytes = Vec::new();
        file.take(maximum as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > maximum {
            return Err(ProjectRenderError::Invalid(
                "raster file grew past byte budget".into(),
            ));
        }
        Ok(bytes)
    }

    fn verify(
        message: ResourceMessage,
        bytes: Vec<u8>,
    ) -> Result<VerifiedResource, ProjectRenderError> {
        let ResourceMessage::PutResource(packet) = message else {
            return Err(ProjectRenderError::Invalid(
                "raster eviction is not admitted".into(),
            ));
        };
        packet.hash.validate()?;
        let verified = VerifiedResource::new(packet.kind, packet.descriptor, bytes)?;
        if verified.request().hash != packet.hash {
            return Err(ProjectRenderError::Invalid(
                "raster resource hash differs".into(),
            ));
        }
        Ok(verified)
    }
}

impl ProjectRasterFrame {
    /// Admit a fresh retained-raster response against this native frame's exact request sequence.
    pub fn load(
        path: &Path,
        requests: &ProjectResourceRequests,
        limits: &ProjectRenderLimits,
        cancellation: &CancellationToken,
    ) -> Result<Self, ProjectRenderError> {
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        let manifest: RasterManifest = serde_json::from_slice(&RasterManifest::read(
            path,
            limits.render_project_input_bytes,
        )?)?;
        let directory = path
            .parent()
            .ok_or_else(|| ProjectRenderError::Invalid("raster directory absent".into()))?
            .canonicalize()?;
        Self::admit(
            manifest,
            requests,
            limits,
            cancellation,
            None,
            |name, maximum| {
                let file = directory.join(name).canonicalize()?;
                if !file.starts_with(&directory) {
                    return Err(ProjectRenderError::Invalid(
                        "raster payload escapes directory".into(),
                    ));
                }
                RasterManifest::read(&file, maximum)
            },
        )
    }

    pub(crate) fn admit(
        manifest: RasterManifest,
        requests: &ProjectResourceRequests,
        limits: &ProjectRenderLimits,
        cancellation: &CancellationToken,
        mut cache: Option<&mut RasterPayloadCache>,
        mut read_payload: impl FnMut(&str, usize) -> Result<Vec<u8>, ProjectRenderError>,
    ) -> Result<Self, ProjectRenderError> {
        if manifest.request_sha256 != format!("{:x}", Sha256::digest(serde_json::to_vec(requests)?))
        {
            return Err(ProjectRenderError::Invalid(
                "retained raster request identity differs".into(),
            ));
        }
        let mut result = Self {
            request_sha256: Some(manifest.request_sha256),
            bindings: manifest.bindings,
            temporal: manifest.temporal,
            text_bounds: manifest.text_bounds,
            motion_text_bounds: manifest.previous_text_bounds,
            ..Default::default()
        };
        result.validate(requests, limits.render_project_pixel_bytes)?;
        if manifest.resources.len() > limits.bundle.max_bundle_resources
            || manifest.pixels.len() > 65536
        {
            return Err(ProjectRenderError::Invalid(
                "raster resource count exceeds budget".into(),
            ));
        }
        let mut packets = BTreeMap::new();
        let mut next_resources = BTreeMap::new();
        let mut remaining_cache = cache.as_ref().map_or(0, |cache| cache.budget_bytes);
        // Descriptor proofs share the existing cache budget; reserve most residency for pixels.
        let mut descriptor_budget = remaining_cache / 16;
        for message in manifest.resources {
            let (resource, bytes) = message.verify(cache.as_deref())?;
            if !matches!(
                resource.request().descriptor,
                ResourceDescriptor::MediaSource(_) | ResourceDescriptor::MediaFrame(_)
            ) {
                return Err(ProjectRenderError::Invalid(
                    "raster descriptor requires a payload".into(),
                ));
            }
            let hash = resource.request().hash.clone();
            if !next_resources.contains_key(&hash) && bytes <= descriptor_budget {
                descriptor_budget -= bytes;
                remaining_cache -= bytes;
                next_resources.insert(hash.clone(), (resource.clone(), bytes));
            }
            packets.insert(hash, resource);
        }
        let mut payloads = BTreeMap::<ResourceHash, (VerifiedResource, String)>::new();
        let mut next_cache = BTreeMap::new();
        let mut remaining = limits.render_project_pixel_bytes;
        for item in manifest.pixels {
            if cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            let frame = RasterManifest::verify(item.frame, Vec::new())?;
            let ResourceDescriptor::MediaFrame(_) = frame.request().descriptor else {
                return Err(ProjectRenderError::Invalid(
                    "raster frame descriptor absent".into(),
                ));
            };
            if packets
                .get(&frame.request().hash)
                .map(VerifiedResource::request)
                != Some(frame.request())
            {
                return Err(ProjectRenderError::Invalid(
                    "raster frame is not declared".into(),
                ));
            }
            let ResourceMessage::PutResource(ref message) = item.message else {
                return Err(ProjectRenderError::Invalid(
                    "raster pixels cannot be evicted".into(),
                ));
            };
            message.hash.validate()?;
            if item.file != format!("{}.bin", message.hash.0) {
                return Err(ProjectRenderError::Invalid(
                    "raster payload filename differs".into(),
                ));
            }
            let pixels = if let Some((pixels, digest)) = payloads.get(&message.hash) {
                if pixels.request() != message || *digest != item.sha256 {
                    return Err(ProjectRenderError::Invalid(
                        "duplicate raster payload differs".into(),
                    ));
                }
                pixels.clone()
            } else {
                let cached = cache
                    .as_ref()
                    .and_then(|cache| cache.entries.get(&item.file));
                let pixels = if let Some((pixels, digest)) = cached {
                    if pixels.request() != message || *digest != item.sha256 {
                        return Err(ProjectRenderError::Invalid(
                            "resident raster identity differs".into(),
                        ));
                    }
                    pixels.clone()
                } else {
                    let bytes = read_payload(&item.file, remaining)?;
                    if bytes.len() > remaining {
                        return Err(ProjectRenderError::Invalid(
                            "raster payload exceeds byte budget".into(),
                        ));
                    }
                    if format!("{:x}", Sha256::digest(&bytes)) != item.sha256 {
                        return Err(ProjectRenderError::Invalid(
                            "raster payload SHA-256 differs".into(),
                        ));
                    }
                    RasterManifest::verify(item.message, bytes)?
                };
                if pixels.bytes().len() > remaining {
                    return Err(ProjectRenderError::Invalid(
                        "raster payload exceeds byte budget".into(),
                    ));
                }
                remaining -= pixels.bytes().len();
                if pixels.bytes().len() <= remaining_cache {
                    remaining_cache -= pixels.bytes().len();
                    next_cache.insert(item.file, (pixels.clone(), item.sha256.clone()));
                }
                payloads.insert(pixels.request().hash.clone(), (pixels.clone(), item.sha256));
                pixels
            };
            result.pixels.push(BundleMediaPixels {
                frame: frame.request().hash.clone(),
                pixels,
            });
        }
        result.resources = packets.into_values().collect();
        result.validate(requests, limits.render_project_pixel_bytes)?;
        if let Some(cache) = cache.as_mut() {
            cache.entries = next_cache;
            cache.resources = next_resources;
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aster_render_ir::{CompositionIdentity, MediaKind, MediaSourceDescriptor};

    #[test]
    fn descriptor_references_require_retained_verified_ownership()
    -> Result<(), Box<dyn std::error::Error>> {
        let resource = VerifiedResource::new(
            aster_render_ir::ResourceKind::MediaSource,
            ResourceDescriptor::MediaSource(MediaSourceDescriptor {
                source_id: CompositionIdentity::Unicode("text".into()),
                content_identity: "immutable text generation".into(),
                authorization_scope: "job".into(),
                media_kind: MediaKind::Raster,
            }),
            Vec::new(),
        )?;
        let hash = resource.request().hash.clone();
        let reference = || {
            RasterResourceMessage::Resident(ResidentRasterResource::ResidentResource {
                hash: hash.clone(),
            })
        };
        let mut cache = RasterPayloadCache {
            budget_bytes: 4096,
            entries: BTreeMap::new(),
            resources: BTreeMap::new(),
        };
        assert!(reference().verify(None).is_err());
        assert!(reference().verify(Some(&cache)).is_err());
        let (verified, bytes) = RasterResourceMessage::Complete(ResourceMessage::PutResource(
            resource.request().clone(),
        ))
        .verify(None)?;
        cache.resources.insert(hash.clone(), (verified, bytes));
        let (resident, resident_bytes) = reference().verify(Some(&cache))?;
        assert_eq!(resident.request(), resource.request());
        assert_eq!(resident_bytes, bytes);
        let mut forged = resource.request().clone();
        forged.hash = ResourceHash("f".repeat(64));
        assert!(
            RasterResourceMessage::Complete(ResourceMessage::PutResource(forged))
                .verify(Some(&cache))
                .is_err()
        );
        cache.resources.clear();
        assert!(reference().verify(Some(&cache)).is_err());
        assert!(
            serde_json::from_str::<RasterResourceMessage>(
                r#"{"type":"resident_resource","hash":"bad"}"#
            )?
            .verify(Some(&cache))
            .is_err()
        );
        Ok(())
    }
}

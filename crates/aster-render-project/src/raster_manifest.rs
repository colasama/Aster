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
    resources: Vec<ResourceMessage>,
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
        Self::admit(manifest, requests, limits, cancellation, |name, maximum| {
            let file = directory.join(name).canonicalize()?;
            if !file.starts_with(&directory) {
                return Err(ProjectRenderError::Invalid(
                    "raster payload escapes directory".into(),
                ));
            }
            RasterManifest::read(&file, maximum)
        })
    }

    pub(crate) fn admit(
        manifest: RasterManifest,
        requests: &ProjectResourceRequests,
        limits: &ProjectRenderLimits,
        cancellation: &CancellationToken,
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
        for message in manifest.resources {
            let resource = RasterManifest::verify(message, Vec::new())?;
            if !matches!(
                resource.request().descriptor,
                ResourceDescriptor::MediaSource(_) | ResourceDescriptor::MediaFrame(_)
            ) {
                return Err(ProjectRenderError::Invalid(
                    "raster descriptor requires a payload".into(),
                ));
            }
            packets.insert(resource.request().hash.clone(), resource);
        }
        let mut payloads = BTreeMap::<ResourceHash, VerifiedResource>::new();
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
            let pixels = if let Some(pixels) = payloads.get(&message.hash) {
                if pixels.request() != message
                    || format!("{:x}", Sha256::digest(pixels.bytes())) != item.sha256
                {
                    return Err(ProjectRenderError::Invalid(
                        "duplicate raster payload differs".into(),
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
                remaining -= bytes.len();
                let pixels = RasterManifest::verify(item.message, bytes)?;
                payloads.insert(pixels.request().hash.clone(), pixels.clone());
                pixels
            };
            result.pixels.push(BundleMediaPixels {
                frame: frame.request().hash.clone(),
                pixels,
            });
        }
        result.resources = packets.into_values().collect();
        result.validate(requests, limits.render_project_pixel_bytes)?;
        Ok(result)
    }
}

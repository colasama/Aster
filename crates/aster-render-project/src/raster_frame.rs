use crate::ProjectRenderError;
use aster_eval::{
    BundleMediaPixels, ProjectResourceRequests, ResourcePreparationOperation, TemporalRasterPass,
    TextGeometryBounds,
};
use aster_render_ir::{MediaKind, ResourceDescriptor, ResourceHash, VerifiedResource};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// Only raster products cross this boundary; scene traversal and shutter requests stay native.
#[derive(Default)]
pub struct ProjectRasterFrame {
    pub request_sha256: Option<String>,
    pub bindings: BTreeMap<String, Option<ResourceHash>>,
    pub resources: Vec<VerifiedResource>,
    pub pixels: Vec<BundleMediaPixels>,
    pub temporal: Vec<TemporalRasterPass>,
    pub text_bounds: BTreeMap<String, TextGeometryBounds>,
    pub motion_text_bounds: BTreeMap<String, TextGeometryBounds>,
}

impl ProjectRasterFrame {
    pub(crate) fn validate(
        &self,
        requests: &ProjectResourceRequests,
        pixel_budget: usize,
    ) -> Result<(), ProjectRenderError> {
        let expected = requests
            .operations
            .iter()
            .filter_map(|operation| match operation {
                ResourcePreparationOperation::Raster { request } => {
                    Some(request.instance_id.as_str())
                }
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        if !expected.is_empty()
            && self.request_sha256.as_deref()
                != Some(format!("{:x}", Sha256::digest(serde_json::to_vec(requests)?)).as_str())
        {
            return Err(ProjectRenderError::Invalid(
                "retained raster request identity differs".into(),
            ));
        }
        if expected != self.bindings.keys().map(String::as_str).collect()
            || self.resources.len() > 65536
            || self.pixels.len() > 65536
            || self.temporal.len() > 65536
            || self.text_bounds.len() > 65536
            || self.motion_text_bounds.len() > 65536
            || self
                .text_bounds
                .keys()
                .any(|key| !expected.contains(key.as_str()))
        {
            return Err(ProjectRenderError::Invalid(
                "retained raster closure differs from native requests".into(),
            ));
        }
        for bounds in self
            .text_bounds
            .values()
            .chain(self.motion_text_bounds.values())
        {
            if ![bounds.x, bounds.y, bounds.width, bounds.height]
                .iter()
                .all(|v| v.is_finite())
                || bounds.width < 0.
                || bounds.height < 0.
            {
                return Err(ProjectRenderError::Invalid(
                    "invalid retained raster bounds".into(),
                ));
            }
        }
        for resource in &self.resources {
            match &resource.request().descriptor {
                ResourceDescriptor::Buffer(_) => {}
                ResourceDescriptor::MediaSource(source)
                    if source.media_kind == MediaKind::Raster
                        && source.authorization_scope == requests.header.snapshot_scope => {}
                ResourceDescriptor::MediaFrame(_) => {}
                _ => {
                    return Err(ProjectRenderError::Invalid(
                        "retained raster resource kind is not admitted".into(),
                    ));
                }
            }
        }
        let mut unique = BTreeSet::new();
        let mut bytes = 0_usize;
        for pixels in &self.pixels {
            if unique.insert(&pixels.pixels.request().hash) {
                bytes = bytes
                    .checked_add(pixels.pixels.bytes().len())
                    .ok_or_else(|| {
                        ProjectRenderError::Invalid("raster pixel byte overflow".into())
                    })?;
            }
        }
        if bytes > pixel_budget {
            return Err(ProjectRenderError::Invalid(
                "retained raster pixel budget exceeded".into(),
            ));
        }
        Ok(())
    }
}

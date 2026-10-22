use crate::{
    NativeProjectDocument, NativeProjectText, PreparedProjectText, ProjectRasterFrame,
    ProjectRenderError, ProjectTextOutcome, ProjectTextRequest, TextCapability, TextFontEvidence,
    text_style::ProjectTextStyle,
};
use aster_eval::{
    ProjectResourceRequests, ResourcePreparationOperation, ResourceRequestContext,
    RetainedRasterKind, TextGeometryBounds,
};
use aster_render_ir::{
    CompositionIdentity, MediaFrameDescriptor, MediaKind, MediaSample, MediaSourceDescriptor,
    MediaTextureFormat, RasterOrigin, RasterSample, ResourceDescriptor, ResourceHash, ResourceKind,
    VerifiedResource,
};
use aster_renderer::NativeGlyphInput;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Serialize)]
pub struct ProjectTextRoute {
    pub instance_id: String,
    pub frame: Option<ResourceHash>,
    pub capability: TextCapability,
}

pub struct ProjectTextFrame {
    pub rasters: ProjectRasterFrame,
    pub native: Vec<NativeGlyphInput>,
    pub routes: Vec<ProjectTextRoute>,
}

/// A retained response is authenticated against its exact subset before native resources merge.
pub(crate) struct ProjectTextRouting {
    pub retained: ProjectResourceRequests,
    native: BTreeMap<String, PreparedProjectText>,
    pub routes: Vec<ProjectTextRoute>,
}

impl NativeProjectText {
    /// Authenticate the retained subset before merging descriptor-only native glyph resources.
    pub fn acquire(
        &mut self,
        document: &NativeProjectDocument,
        requests: &ProjectResourceRequests,
        context: &ResourceRequestContext,
        pixel_budget: usize,
        acquire: impl FnOnce(&ProjectResourceRequests) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<ProjectTextFrame, ProjectRenderError> {
        let routing = self.partition(document, requests, context)?;
        let retained = acquire(&routing.retained)?;
        let (rasters, native, routes) = routing.merge(retained, pixel_budget)?;
        Ok(ProjectTextFrame {
            rasters,
            native,
            routes,
        })
    }

    pub(crate) fn partition(
        &mut self,
        document: &NativeProjectDocument,
        requests: &ProjectResourceRequests,
        context: &ResourceRequestContext,
    ) -> Result<ProjectTextRouting, ProjectRenderError> {
        let mut native = BTreeMap::new();
        let mut retained_ids = BTreeSet::new();
        let mut routes = Vec::new();
        for operation in &requests.operations {
            let ResourcePreparationOperation::Raster { request } = operation else {
                continue;
            };
            let RetainedRasterKind::Text {
                source_time,
                resolution_scale,
                exposure,
                ..
            } = &request.raster
            else {
                continue;
            };
            let text_request = ProjectTextRequest {
                composition: request.composition_id.clone(),
                layer: request.layer_id.clone(),
                source_time: *source_time,
                resolution_scale: *resolution_scale,
                maximum_dimension: context.maximum_raster_dimension,
                locale: context.locale.clone(),
                bounds: None,
            };
            let layer = document
                .scene
                .layer(&request.composition_id, &request.layer_id)?;
            let style = ProjectTextStyle::from_layer(layer)?;
            let coverage = self.inspect_font_coverage(document, &style, &context.locale)?;
            let animation_reason = if style.animated
                && coverage.reason.is_none()
                && style.color_coverage_reason().is_none()
                && style.stroke_width == 0.
            {
                if let Some(exposure) = exposure {
                    let mut reason = None;
                    for sample in &exposure.samples {
                        let mut sample_request = text_request.clone();
                        sample_request.source_time = sample.local_time;
                        if let Some(limitation) =
                            self.inspect_animation_coverage(document, &style, &sample_request)?
                        {
                            reason =
                                Some(format!("{limitation}; exposure time {}", sample.local_time));
                            break;
                        }
                    }
                    reason
                } else {
                    self.inspect_animation_coverage(document, &style, &text_request)?
                }
            } else {
                None
            };
            let reason = if !cfg!(windows) {
                Some("platform coverage has not been qualified on this host")
            } else if let Some(reason) = style.color_coverage_reason() {
                Some(reason)
            } else if let Some(reason) = &coverage.reason {
                Some(reason.as_str())
            } else if style.stroke_width > 0. {
                Some("stroke coverage exceeds the isolated raster alpha limit")
            } else if style.animated {
                Some(animation_reason.as_deref().map_or(
                    "per-character paint and affine coverage require pixel qualification",
                    |reason| reason,
                ))
            } else if exposure.is_some() {
                Some("temporal glyph union and sample routing require pixel qualification")
            } else if *resolution_scale != 1. {
                Some("scaled glyph density requires isolated pixel qualification")
            } else if !style.text.is_ascii() {
                Some("script raster coverage requires isolated pixel qualification")
            } else if !style
                .families
                .first()
                .is_some_and(|f| !f.quoted && matches!(f.name.as_str(), "Arial" | "Segoe UI"))
            {
                Some("requested primary family and CSS family syntax require raster qualification")
            } else if layer
                .text_style
                .value()
                .is_some_and(|s| s.font_family.contains(['\\', '\'', '"']))
            {
                Some("quoted or escaped CSS font families require raster qualification")
            } else {
                None
            };
            let outcome = if let Some(reason) = reason {
                ProjectTextOutcome::Retained(Box::new(TextCapability {
                    project_sha256: document.runtime_sha256.clone(),
                    request: text_request,
                    stage: "production-coverage".into(),
                    reason: reason.into(),
                    fonts: coverage.fonts,
                }))
            } else {
                self.prepare(document, text_request)?
            };
            match outcome {
                ProjectTextOutcome::Native(prepared) => {
                    let reason = if prepared
                        .fonts
                        .iter()
                        .any(|font| !matches!(font.family.as_str(), "Arial" | "Segoe UI"))
                    {
                        Some("selected font face requires isolated raster qualification")
                    } else if prepared
                        .plan
                        .draws
                        .iter()
                        .any(|d| d.transform != [1., 0., 0., 1., 0., 0.])
                    {
                        Some("non-translation glyph coverage requires pixel qualification")
                    } else if prepared
                        .atlas
                        .pages
                        .iter()
                        .any(|p| p.format != aster_text::GlyphImageFormat::Coverage)
                    {
                        Some("color glyph coverage requires pixel qualification")
                    } else {
                        None
                    };
                    if let Some(reason) = reason {
                        retained_ids.insert(request.instance_id.clone());
                        routes.push(ProjectTextRoute {
                            instance_id: request.instance_id.clone(),
                            frame: None,
                            capability: TextCapability {
                                project_sha256: prepared.project_sha256,
                                request: prepared.request,
                                stage: "production-coverage".into(),
                                reason: reason.into(),
                                fonts: prepared.fonts.iter().map(TextFontEvidence::from).collect(),
                            },
                        });
                        continue;
                    }
                    let size = prepared.plan.size;
                    if u64::from(size.width) * u64::from(size.height)
                        > context.maximum_raster_pixels
                    {
                        return Err(ProjectRenderError::Invalid(
                            "native text pixel budget exceeded".into(),
                        ));
                    }
                    // Repeated cloner instances preserve the provider's last-write semantics.
                    native.insert(request.instance_id.clone(), *prepared);
                }
                ProjectTextOutcome::Retained(capability) => {
                    retained_ids.insert(request.instance_id.clone());
                    routes.push(ProjectTextRoute {
                        instance_id: request.instance_id.clone(),
                        frame: None,
                        capability: *capability,
                    });
                }
            }
        }
        native.retain(|id, _| !retained_ids.contains(id));
        let mut retained = requests.clone();
        retained.operations.retain(|operation| !matches!(operation,
            ResourcePreparationOperation::Raster { request } if native.contains_key(&request.instance_id)));
        Ok(ProjectTextRouting {
            retained,
            native,
            routes,
        })
    }
}

impl ProjectTextRouting {
    pub fn merge(
        mut self,
        mut rasters: ProjectRasterFrame,
        pixel_budget: usize,
    ) -> Result<
        (
            ProjectRasterFrame,
            Vec<NativeGlyphInput>,
            Vec<ProjectTextRoute>,
        ),
        ProjectRenderError,
    > {
        rasters.validate(&self.retained, pixel_budget)?;
        let mut inputs = Vec::new();
        for (id, prepared) in self.native {
            let identity = format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(&(
                    &prepared.project_sha256,
                    &prepared.request,
                    &prepared.atlas.identity,
                    &prepared.plan.size,
                    &prepared.plan.draws,
                ))?)
            );
            let source = VerifiedResource::new(
                ResourceKind::MediaSource,
                ResourceDescriptor::MediaSource(MediaSourceDescriptor {
                    source_id: CompositionIdentity::Unicode(prepared.request.layer.clone()),
                    content_identity: identity,
                    authorization_scope: self.retained.header.snapshot_scope.clone(),
                    media_kind: MediaKind::Raster,
                }),
                Vec::new(),
            )?;
            let mut words = [0; 8];
            for (i, value) in prepared.bounds.iter().enumerate() {
                let bits = value.to_bits();
                words[i * 2] = bits as u32;
                words[i * 2 + 1] = (bits >> 32) as u32;
            }
            let frame = VerifiedResource::new(
                ResourceKind::MediaFrame,
                ResourceDescriptor::MediaFrame(MediaFrameDescriptor {
                    source: source.request().hash.clone(),
                    sample: MediaSample::Raster(RasterSample {
                        origin: RasterOrigin::Text,
                        bounds_f64_le: words,
                    }),
                    width: prepared.plan.size.width,
                    height: prepared.plan.size.height,
                    format: MediaTextureFormat::Rgba8UnormSrgb,
                }),
                Vec::new(),
            )?;
            let hash = frame.request().hash.clone();
            if rasters
                .bindings
                .insert(id.clone(), Some(hash.clone()))
                .is_some()
            {
                return Err(ProjectRenderError::Invalid(
                    "native and retained text bindings overlap".into(),
                ));
            }
            let [x, y, width, height] = prepared.bounds;
            rasters.text_bounds.insert(
                id.clone(),
                TextGeometryBounds {
                    x,
                    y,
                    width,
                    height,
                },
            );
            self.routes.push(ProjectTextRoute {
                instance_id: id,
                frame: Some(hash.clone()),
                capability: TextCapability {
                    project_sha256: prepared.project_sha256.clone(),
                    request: prepared.request.clone(),
                    stage: "native-glyph".into(),
                    reason: "ordinary outline fill through the platform glyph atlas".into(),
                    fonts: prepared.fonts.iter().map(TextFontEvidence::from).collect(),
                },
            });
            rasters.resources.extend([source, frame]);
            inputs.push(prepared.into_input(hash, pixel_budget as u64)?);
        }
        // This merged internal object is not a purported retained-provider response.
        rasters.request_sha256 = None;
        Ok((rasters, inputs, self.routes))
    }
}

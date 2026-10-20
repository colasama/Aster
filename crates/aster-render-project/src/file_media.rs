use crate::{NativeProjectDocument, ProjectRenderError};
use aster_eval::{
    BundleMediaPixels, BundleResources, FramePlanRequest, ProjectResourceRequests,
    ResourcePreparationOperation, ResourceRequestContext,
};
use aster_media_native::{NativeProjectMediaSession, ProjectMediaLimits, ProjectMediaTools};
use aster_project::MediaSourceReader;
use aster_render_ir::{MediaKind, ResourceDescriptor, ResourceHash, VerifiedResource};
use aster_video::CancellationToken;
use std::collections::{BTreeMap, BTreeSet};

pub struct ProjectFileMediaFrame {
    pub requests: ProjectResourceRequests,
    pub bindings: BTreeMap<String, Option<ResourceHash>>,
    pub resources: Vec<VerifiedResource>,
    pub pixels: Vec<BundleMediaPixels>,
}

/// Preflight admits only sources selected by native evaluation of the bounded job schedule.
pub struct NativeProjectFileMedia {
    pub(crate) document: NativeProjectDocument,
    session: NativeProjectMediaSession,
    scope: String,
    admitted: BTreeSet<String>,
    poisoned: bool,
}

impl NativeProjectFileMedia {
    pub fn new(
        document: NativeProjectDocument,
        frames: &[FramePlanRequest],
        context: &ResourceRequestContext,
        tools: ProjectMediaTools,
        limits: ProjectMediaLimits,
        cancellation: &CancellationToken,
    ) -> Result<Self, ProjectRenderError> {
        if frames.is_empty() || frames.len() > document.limits.render_project_frames {
            return Err(ProjectRenderError::Invalid(
                "job frame count exceeds limit".into(),
            ));
        }
        let scope = frames[0].snapshot_scope.clone();
        let mut ids = BTreeSet::new();
        let mut contexts = vec![context.clone()];
        if !matches!(
            context.visualization,
            aster_eval::BufferVisualization::Beauty
                | aster_eval::BufferVisualization::LinearColor
                | aster_eval::BufferVisualization::Luminance
                | aster_eval::BufferVisualization::Alpha
        ) {
            let mut fallback = context.clone();
            fallback.visualization = aster_eval::BufferVisualization::Beauty;
            contexts.push(fallback);
        }
        for frame in frames {
            if cancellation.is_cancelled() {
                return Err(aster_media_native::MediaError::from(
                    aster_video::FfmpegError::Cancelled,
                )
                .into());
            }
            if frame.snapshot_scope != scope {
                return Err(ProjectRenderError::Invalid(
                    "job snapshot scope changed".into(),
                ));
            }
            for context in &contexts {
                let prepared = document.resource_requests(frame, context)?;
                for operation in prepared.operations {
                    if let ResourcePreparationOperation::Media {
                        source_id: Some(id),
                        ..
                    } = operation
                    {
                        ids.insert(id);
                    }
                }
            }
        }
        let bindings = ids
            .iter()
            .map(|id| document.catalog.bind(id))
            .collect::<Result<Vec<_>, _>>()?;
        let mut reader = MediaSourceReader::new(&document.root, document.limits.sources.clone())?;
        let session = NativeProjectMediaSession::new(
            bindings,
            &mut reader,
            &scope,
            tools,
            limits,
            cancellation,
        )?;
        Ok(Self {
            document,
            session,
            scope,
            admitted: ids,
            poisoned: false,
        })
    }

    /// Descriptor-only diagnostics and pixel execution share source clocks and immutable grants.
    /// An interrupted acquisition poisons the session so partial cache clocks cannot be reused.
    pub fn acquire(
        &mut self,
        frame: &FramePlanRequest,
        context: &ResourceRequestContext,
        decode_pixels: bool,
        cancellation: &CancellationToken,
    ) -> Result<ProjectFileMediaFrame, ProjectRenderError> {
        if self.poisoned || frame.snapshot_scope != self.scope {
            return Err(ProjectRenderError::Invalid(
                "file media session is not ready for this snapshot".into(),
            ));
        }
        let result = self.acquire_frame(frame, context, decode_pixels, cancellation);
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }

    fn acquire_frame(
        &mut self,
        frame: &FramePlanRequest,
        context: &ResourceRequestContext,
        decode_pixels: bool,
        cancellation: &CancellationToken,
    ) -> Result<ProjectFileMediaFrame, ProjectRenderError> {
        if cancellation.is_cancelled() {
            return Err(
                aster_media_native::MediaError::from(aster_video::FfmpegError::Cancelled).into(),
            );
        }
        let requests = self.document.resource_requests(frame, context)?;
        let mut budget = BundleResources::new(self.document.limits.bundle.clone())?;
        let mut resources = BTreeMap::new();
        let mut pixels = BTreeMap::new();
        let mut pixel_sizes = BTreeMap::new();
        let mut pixel_bytes = 0_usize;
        let mut bindings = BTreeMap::new();
        for operation in &requests.operations {
            if cancellation.is_cancelled() {
                return Err(aster_media_native::MediaError::from(
                    aster_video::FfmpegError::Cancelled,
                )
                .into());
            }
            let ResourcePreparationOperation::Media {
                composition_id,
                layer_id,
                instance_id,
                source_id,
                local_time,
            } = operation
            else {
                continue;
            };
            let Some(source_id) = source_id else {
                bindings.insert(instance_id.clone(), None);
                continue;
            };
            if !self.admitted.contains(source_id) {
                return Err(ProjectRenderError::Invalid(
                    "frame requires a source outside the job admission".into(),
                ));
            }
            let info = self.session.source_info(source_id)?;
            let duration = match info.kind {
                MediaKind::Video => (info
                    .duration
                    .ok_or_else(|| ProjectRenderError::Invalid("video duration absent".into()))?
                    - 0.001)
                    .max(0.0),
                MediaKind::Sequence => info.duration.ok_or_else(|| {
                    ProjectRenderError::Invalid("sequence duration absent".into())
                })?,
                _ => f64::INFINITY,
            };
            let time =
                self.document
                    .scene
                    .source_time(composition_id, layer_id, *local_time, duration)?;
            let (source, media) = if decode_pixels {
                let decoded =
                    self.session
                        .decode(source_id, instance_id, time, false, cancellation)?;
                let pixel_hash = decoded.decoded.pixels.request().hash.clone();
                if let std::collections::btree_map::Entry::Vacant(entry) =
                    pixel_sizes.entry(pixel_hash)
                {
                    pixel_bytes = pixel_bytes
                        .checked_add(decoded.decoded.pixels.bytes().len())
                        .ok_or_else(|| {
                            ProjectRenderError::Invalid("decoded pixel size overflow".into())
                        })?;
                    if pixel_bytes > self.document.limits.render_project_pixel_bytes {
                        return Err(ProjectRenderError::Invalid(
                            "decoded frame pixel budget exceeded".into(),
                        ));
                    }
                    entry.insert(decoded.decoded.pixels.bytes().len());
                }
                pixels.insert(decoded.frame.request().hash.clone(), decoded.decoded.pixels);
                (decoded.source, decoded.frame)
            } else {
                let prepared = self.session.prepare(source_id, instance_id, time, false)?;
                (prepared.source, prepared.frame)
            };
            bindings.insert(instance_id.clone(), Some(media.request().hash.clone()));
            budget.add(source.clone())?;
            budget.add(media.clone())?;
            resources.insert(source.request().hash.clone(), source);
            resources.insert(media.request().hash.clone(), media);
        }
        let mut used = bindings
            .values()
            .flatten()
            .cloned()
            .collect::<BTreeSet<_>>();
        for frame in used.clone() {
            if let Some(resource) = resources.get(&frame)
                && let ResourceDescriptor::MediaFrame(descriptor) = &resource.request().descriptor
            {
                used.insert(descriptor.source.clone());
            }
        }
        resources.retain(|hash, _| used.contains(hash));
        pixels.retain(|hash, _| used.contains(hash));
        Ok(ProjectFileMediaFrame {
            requests,
            bindings,
            resources: resources.into_values().collect(),
            pixels: pixels
                .into_iter()
                .map(|(frame, pixels)| BundleMediaPixels { frame, pixels })
                .collect(),
        })
    }
}

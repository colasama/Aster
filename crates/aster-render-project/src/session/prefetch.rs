use super::*;

/// One immutable acquisition can overlap a submitted GPU frame without allocating GPU targets.
/// The request and settings travel with the pixels, so consumption cannot substitute either.
pub(crate) struct PrefetchedFileMedia {
    frame: FramePlanRequest,
    settings: ProjectFrameSettings,
    files: crate::ProjectFileMediaFrame,
    elapsed_ms: f64,
    generation: u64,
    owner: Arc<()>,
}

impl NativeProjectSession {
    pub(crate) fn prefetch_file_media(
        &mut self,
        frame: &FramePlanRequest,
        settings: &ProjectFrameSettings,
        cancellation: &CancellationToken,
    ) -> Result<Option<PrefetchedFileMedia>, ProjectRenderError> {
        // Diagnostic fallback requires GPU allocation before resource evaluation.
        if !matches!(
            settings.resources.visualization,
            BufferVisualization::Beauty
        ) {
            return Ok(None);
        }
        if self.poisoned
            || self.pending.is_some()
            || frame.composition_id != self.audio.composition_id
        {
            return Err(ProjectRenderError::Invalid(
                "native project session is not ready for media prefetch".into(),
            ));
        }
        let started = Instant::now();
        let result = self
            .files
            .acquire(frame, &settings.resources, true, cancellation);
        match result {
            Ok(files) => Ok(Some(PrefetchedFileMedia {
                frame: frame.clone(),
                settings: settings.clone(),
                files,
                elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                generation: self.generation,
                owner: Arc::clone(&self.owner),
            })),
            Err(error) => {
                self.poisoned = true;
                Err(error)
            }
        }
    }

    pub(crate) fn prepare_prefetched(
        &mut self,
        prefetched: PrefetchedFileMedia,
        cancellation: &CancellationToken,
        acquire_rasters: impl FnOnce(
            &ProjectResourceRequests,
        ) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<PreparedProjectFrame, ProjectRenderError> {
        if prefetched.generation != self.generation || !Arc::ptr_eq(&prefetched.owner, &self.owner)
        {
            return Err(ProjectRenderError::Invalid(
                "prefetched media belongs to a different session or generation".into(),
            ));
        }
        self.prepare_inputs(
            &prefetched.frame,
            &prefetched.settings,
            Some((prefetched.files, prefetched.elapsed_ms)),
            cancellation,
            acquire_rasters,
        )
    }
}

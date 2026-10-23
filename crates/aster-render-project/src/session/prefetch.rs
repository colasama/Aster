use super::*;

/// One immutable acquisition can overlap a submitted GPU frame without allocating GPU targets.
/// The request and settings travel with the pixels, so consumption cannot substitute either.
pub(crate) struct PrefetchedProjectInputs {
    frame: FramePlanRequest,
    settings: ProjectFrameSettings,
    inputs: inputs::PreparedProjectInputs,
    generation: u64,
    owner: Arc<()>,
}

impl NativeProjectSession {
    pub(crate) fn prefetch_inputs(
        &mut self,
        frame: &FramePlanRequest,
        settings: &ProjectFrameSettings,
        cancellation: &CancellationToken,
        acquire_rasters: impl FnOnce(
            &ProjectResourceRequests,
        ) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<Option<PrefetchedProjectInputs>, ProjectRenderError> {
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
                "native project session is not ready for input prefetch".into(),
            ));
        }
        let result = self.acquire_inputs(frame, &settings.resources, cancellation, acquire_rasters);
        match result {
            Ok(inputs) => Ok(Some(PrefetchedProjectInputs {
                frame: frame.clone(),
                settings: settings.clone(),
                inputs,
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
        prefetched: PrefetchedProjectInputs,
        cancellation: &CancellationToken,
        acquire_rasters: impl FnOnce(
            &ProjectResourceRequests,
        ) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<PreparedProjectFrame, ProjectRenderError> {
        if prefetched.generation != self.generation || !Arc::ptr_eq(&prefetched.owner, &self.owner)
        {
            return Err(ProjectRenderError::Invalid(
                "prefetched inputs belong to a different session or generation".into(),
            ));
        }
        self.prepare_inputs(
            &prefetched.frame,
            &prefetched.settings,
            Some(prefetched.inputs),
            cancellation,
            acquire_rasters,
        )
    }
}

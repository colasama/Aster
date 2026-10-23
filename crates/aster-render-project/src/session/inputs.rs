use super::*;

/// CPU products retain immutable pixels and glyph leases without allocating render targets.
pub(super) struct PreparedProjectInputs {
    pub files: crate::ProjectFileMediaFrame,
    pub text: crate::ProjectTextFrame,
    pub timings: crate::ProjectPreparationTimings,
}

impl NativeProjectSession {
    pub(super) fn acquire_inputs(
        &mut self,
        frame: &FramePlanRequest,
        context: &ResourceRequestContext,
        cancellation: &CancellationToken,
        acquire_rasters: impl FnOnce(
            &ProjectResourceRequests,
        ) -> Result<ProjectRasterFrame, ProjectRenderError>,
    ) -> Result<PreparedProjectInputs, ProjectRenderError> {
        let started = Instant::now();
        let files = self.files.acquire(frame, context, true, cancellation)?;
        let mut timings = crate::ProjectPreparationTimings {
            file_media_ms: started.elapsed().as_secs_f64() * 1000.0,
            ..Default::default()
        };
        let phase = Instant::now();
        let mut raster_exchange_ms = 0.0;
        let acquire_rasters = |requests: &ProjectResourceRequests| {
            let exchange = Instant::now();
            let result = acquire_rasters(requests);
            raster_exchange_ms = exchange.elapsed().as_secs_f64() * 1000.0;
            result
        };
        let pixel_budget = self.files.document.limits.render_project_pixel_bytes;
        let has_text = files.requests.operations.iter().any(|operation| {
            matches!(operation,
            aster_eval::ResourcePreparationOperation::Raster { request }
                if matches!(request.raster, aster_eval::RetainedRasterKind::Text { .. }))
        });
        let text = if has_text {
            if self.text.is_none() {
                let fonts = crate::NativeProjectText::discover_platform(
                    &self.files.document,
                    &Default::default(),
                    Default::default(),
                )?;
                self.text = Some(crate::NativeProjectText::new(&self.files.document, fonts)?);
            }
            self.text
                .as_mut()
                .ok_or_else(|| ProjectRenderError::Invalid("native text session absent".into()))?
                .acquire(
                    &self.files.document,
                    &files.requests,
                    context,
                    pixel_budget,
                    acquire_rasters,
                )?
        } else {
            let rasters = acquire_rasters(&files.requests)?;
            rasters.validate(&files.requests, pixel_budget)?;
            crate::ProjectTextFrame {
                rasters,
                native: Vec::new(),
                routes: Vec::new(),
            }
        };
        timings.raster_text_ms = phase.elapsed().as_secs_f64() * 1000.0;
        timings.raster_exchange_ms = raster_exchange_ms;
        timings.total_ms = started.elapsed().as_secs_f64() * 1000.0;
        Ok(PreparedProjectInputs {
            files,
            text,
            timings,
        })
    }
}

use crate::{NativeProjectExport, ProjectExportProgress, ProjectRasterFrame, ProjectRenderError};
use std::time::Instant;

impl NativeProjectExport {
    /// Complete bounded, time-addressed GPU readbacks before a separately timed production export.
    /// The live session, device and caches are preserved; no encoded output is created here.
    pub fn warm_up(
        &mut self,
        frames: u32,
        mut progress: impl FnMut(ProjectExportProgress),
    ) -> Result<(), ProjectRenderError> {
        if frames == 0 {
            return Ok(());
        }
        if frames > 128 || self.schedule.frames.is_empty() {
            return Err(ProjectRenderError::Invalid(
                "export warm-up requires a nonempty schedule and at most 128 frames".into(),
            ));
        }
        let started = Instant::now();
        // Output reservations must precede render targets so the same GPU budget applies to
        // both warm-up and export. Repeated preparation in run() reuses these allocations.
        let renderer = &mut self.session.gpu.renderer;
        #[cfg(not(target_os = "macos"))]
        renderer.prepare_nv12(self.schedule.video.size)?;
        #[cfg(target_os = "macos")]
        renderer.prepare_shared_preview(self.schedule.video.size, 1)?;
        #[cfg(windows)]
        if renderer
            .prepare_shared_nv12(
                self.schedule.video.size,
                self.encoder_options
                    .max_encoder_inflight_frames
                    .saturating_add(1),
            )
            .is_err()
        {
            // Shared surfaces are optional; the production encoder can still select readback.
            renderer.release_shared_nv12()?;
        }
        for index in 0..frames {
            self.control.wait()?;
            let frame = self
                .schedule
                .frames
                .get(index as usize % self.schedule.frames.len())
                .ok_or_else(|| ProjectRenderError::Invalid("warm-up frame is missing".into()))?;
            let prepared = self.session.prepare(
                &frame,
                &self.settings,
                &self.control.cancellation,
                |requests| match &mut self.raster_provider {
                    Some(provider) => provider.acquire(requests, &self.control.cancellation),
                    None => Ok(ProjectRasterFrame::default()),
                },
            )?;
            let rendered = self.session.render(&prepared, &self.control.cancellation)?;
            // Like the retained TS benchmark, wait for completed pixels rather than CPU submit.
            self.session.gpu.renderer.read_rgba(&rendered)?;
            progress(ProjectExportProgress {
                stage: "warmup",
                rendered_frames: u64::from(index) + 1,
                total_frames: u64::from(frames),
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
        Ok(())
    }
}

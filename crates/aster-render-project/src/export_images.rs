use crate::{
    NativeProjectSession, NativeRasterProvider, ProjectExportControl, ProjectExportFormat,
    ProjectExportProgress, ProjectExportSchedule, ProjectFrameSettings, ProjectRasterFrame,
    ProjectRenderError,
};
use aster_eval::FramePlanRequest;
use serde::Serialize;
use std::time::Instant;

/// Owns unpublished image outputs until every scheduled frame has been written successfully.
pub trait ProjectImageOutput {
    fn write_frame(
        &mut self,
        index: u64,
        frame: &FramePlanRequest,
        rgba: Vec<u8>,
    ) -> Result<(), ProjectRenderError>;
    fn finish(&mut self) -> Result<(), ProjectRenderError>;
}

pub struct NativeProjectImageExport {
    pub session: NativeProjectSession,
    pub schedule: ProjectExportSchedule,
    pub settings: ProjectFrameSettings,
    pub raster_provider: Option<NativeRasterProvider>,
    pub control: ProjectExportControl,
}

#[derive(Serialize)]
pub struct ProjectImageExportReport {
    pub frames: u64,
    pub elapsed_ms: u128,
}

impl NativeProjectImageExport {
    pub fn run(
        mut self,
        output: &mut dyn ProjectImageOutput,
        mut progress: impl FnMut(ProjectExportProgress),
    ) -> Result<ProjectImageExportReport, ProjectRenderError> {
        let count = self.schedule.frames.len() as u64;
        if self.schedule.format == ProjectExportFormat::Mp4
            || count == 0
            || (self.schedule.format == ProjectExportFormat::Png && count != 1)
        {
            return Err(ProjectRenderError::Invalid(
                "invalid image export schedule".into(),
            ));
        }
        let started = Instant::now();
        for (index, frame) in self.schedule.frames.iter().enumerate() {
            self.control.wait()?;
            let prepared = self.session.prepare(
                frame,
                &self.settings,
                &self.control.cancellation,
                |requests| match &mut self.raster_provider {
                    Some(provider) => provider.acquire(requests, &self.control.cancellation),
                    None => Ok(ProjectRasterFrame::default()),
                },
            )?;
            let rendered = self.session.render(&prepared, &self.control.cancellation)?;
            // Lossless file delivery requires readback; pixels never cross the host IPC boundary.
            let rgba = self.session.gpu.renderer.read_rgba(&rendered)?;
            output.write_frame(index as u64, frame, rgba)?;
            progress(ProjectExportProgress {
                stage: "render",
                rendered_frames: index as u64 + 1,
                total_frames: count,
                elapsed_ms: started.elapsed().as_millis(),
            });
        }
        self.control.wait()?;
        output.finish()?;
        Ok(ProjectImageExportReport {
            frames: count,
            elapsed_ms: started.elapsed().as_millis(),
        })
    }
}

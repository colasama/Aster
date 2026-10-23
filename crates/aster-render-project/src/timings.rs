use serde::Serialize;

/// Host wall time; raster exchange is a subset of raster/text preparation.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ProjectPreparationTimings {
    pub total_ms: f64,
    pub file_media_ms: f64,
    pub raster_text_ms: f64,
    pub raster_exchange_ms: f64,
    pub materials_ms: f64,
    pub audio_ms: f64,
    pub gpu_setup_ms: f64,
    pub plan_inputs_ms: f64,
    pub plan_ms: f64,
    pub admission_ms: f64,
}

impl ProjectPreparationTimings {
    pub(crate) fn accumulate(&mut self, frame: &Self) {
        self.total_ms += frame.total_ms;
        self.file_media_ms += frame.file_media_ms;
        self.raster_text_ms += frame.raster_text_ms;
        self.raster_exchange_ms += frame.raster_exchange_ms;
        self.materials_ms += frame.materials_ms;
        self.audio_ms += frame.audio_ms;
        self.gpu_setup_ms += frame.gpu_setup_ms;
        self.plan_inputs_ms += frame.plan_inputs_ms;
        self.plan_ms += frame.plan_ms;
        self.admission_ms += frame.admission_ms;
    }
}

/// Aggregate CPU wall time without additional GPU waits or readbacks. Output completion may
/// include GPU execution; concurrent mux work is visible only when publication or joining waits.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ProjectExportTimings {
    pub frames: u64,
    pub setup_ms: f64,
    pub control_wait_ms: f64,
    pub preparation: ProjectPreparationTimings,
    pub render_submit_ms: f64,
    pub output_completion_ms: f64,
    pub observer_ms: f64,
    pub encoder_submit_ms: f64,
    pub packet_publish_ms: f64,
    pub encoder_drain_ms: f64,
    pub mux_completion_ms: f64,
}

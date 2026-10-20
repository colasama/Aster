use crate::{EvaluationError, NativePlan};
use aster_render_ir::{
    ContractLevel, ElementType, FrameHeaderSlice, FrameTime, MotionReconstructionInput,
    MotionReconstructionSlice, MotionReconstructionStatus, PlanSlice,
};
use aster_types::editor::MotionBlur;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionSettings {
    pub enabled: bool,
    pub shutter_angle: f64,
    pub shutter_phase: f64,
    pub samples_per_frame: u32,
    pub adaptive_sample_limit: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShutterInterval {
    pub frame_time: f64,
    pub open_time: f64,
    pub close_time: f64,
    pub duration: f64,
    pub sample_times: Vec<f64>,
}

impl MotionSettings {
    pub fn normalize(source: Option<&MotionBlur>) -> Self {
        let samples = source
            .and_then(|s| s.samples_per_frame.as_f64())
            .unwrap_or(8.0)
            .clamp(2.0, 64.0)
            .round() as u32;
        let adaptive = source
            .and_then(|s| s.adaptive_sample_limit.as_f64())
            .unwrap_or(32.0)
            .clamp(2.0, 128.0)
            .round() as u32;
        Self {
            enabled: source.is_some_and(|s| s.enabled),
            shutter_angle: source
                .and_then(|s| s.shutter_angle.as_f64())
                .unwrap_or(180.0)
                .clamp(0.0, 720.0),
            shutter_phase: source
                .and_then(|s| s.shutter_phase.as_f64())
                .unwrap_or(-90.0)
                .clamp(-720.0, 720.0),
            samples_per_frame: samples,
            adaptive_sample_limit: samples.max(adaptive),
        }
    }

    pub fn adaptive_samples(&self, travel: f64) -> u32 {
        let travel = if travel.is_finite() {
            travel.clamp(0.0, 1_000_000.0)
        } else {
            0.0
        };
        self.adaptive_sample_limit
            .max(self.samples_per_frame)
            .min(self.samples_per_frame.max((travel / 8.0).ceil() as u32 + 1))
    }

    pub fn interval(&self, time: f64, frame_rate: f64, samples: Option<u32>) -> ShutterInterval {
        let frame_time = if time.is_finite() { time } else { 0.0 };
        let rate = if frame_rate.is_finite() {
            frame_rate.clamp(1.0, 1000.0)
        } else {
            60.0
        };
        let frame_duration = 1.0 / rate;
        let duration = self.shutter_angle / 360.0 * frame_duration;
        let open_time = frame_time + self.shutter_phase / 360.0 * frame_duration;
        let count = if duration > 0.0 {
            samples.unwrap_or(self.samples_per_frame).clamp(2, 128)
        } else {
            0
        };
        ShutterInterval {
            frame_time,
            open_time,
            close_time: open_time + duration,
            duration,
            sample_times: (0..count)
                .map(|i| open_time + ((f64::from(i) + 0.5) / f64::from(count)) * duration)
                .collect(),
        }
    }

    pub fn reconstruction(
        &self,
        header: FrameHeaderSlice,
        interval: &ShutterInterval,
        requested: bool,
        resources_available: bool,
        composition_width: f64,
    ) -> Result<NativePlan, EvaluationError> {
        let time = header
            .time
            .to_f64()
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let position = if interval.duration > f64::EPSILON {
            (time - interval.open_time) / interval.duration
        } else {
            0.5
        };
        let radius = (256.0 * (f64::from(header.render_target.width) / composition_width.max(1.0)))
            .clamp(1.0, 256.0);
        let words = [
            (header.render_target.width as f32).to_bits(),
            (header.render_target.height as f32).to_bits(),
            self.samples_per_frame.clamp(2, 64),
            self.adaptive_sample_limit
                .clamp(2, 128)
                .max(self.samples_per_frame.clamp(2, 64)),
            (radius as f32).to_bits(),
            (position.clamp(-4.0, 4.0) as f32).to_bits(),
            0,
            0,
        ];
        NativePlan::single(
            header,
            ContractLevel::MotionReconstructionSliceV1,
            PlanSlice::MotionReconstruction(MotionReconstructionSlice {
                blob_index: 0,
                status: if requested && resources_available {
                    MotionReconstructionStatus::Ready
                } else {
                    MotionReconstructionStatus::Skipped
                },
                inputs: [
                    MotionReconstructionInput::Scene,
                    MotionReconstructionInput::MotionVector,
                    MotionReconstructionInput::ObjectId,
                ],
                shutter_open: FrameTime::from_f64(interval.open_time)
                    .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?,
                shutter_duration: FrameTime::from_f64(interval.duration)
                    .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?,
            }),
            ElementType::U8,
            words.iter().flat_map(|n| n.to_le_bytes()).collect(),
            Vec::new(),
        )
    }
}

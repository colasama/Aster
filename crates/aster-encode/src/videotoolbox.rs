use crate::{EncodeError, EncodedPacket, EncoderOptions, EncoderStatistics, timing::FrameClock};
use aster_macos::{Surface, VideoEncoder};
use aster_render_ir::ExportVideoConfig;
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct VtEncoder {
    encoder: Option<VideoEncoder>,
    video: ExportVideoConfig,
    frames: u64,
    pub statistics: EncoderStatistics,
}

impl VtEncoder {
    pub(crate) fn new(
        video: ExportVideoConfig,
        frames: u64,
        options: EncoderOptions,
    ) -> Result<Self, EncodeError> {
        options.validate(&video, frames)?;
        let bytes = u64::from(video.size.width) * u64::from(video.size.height) * 4;
        if bytes > options.encoder_inflight_byte_budget {
            return Err(EncodeError::Invalid(
                "IOSurface encoder exceeds input budget".into(),
            ));
        }
        let encoder = VideoEncoder::new(
            [video.size.width, video.size.height],
            [video.frame_rate.numerator, video.frame_rate.denominator],
            video.bitrate_bps,
            options.max_encoder_packet_bytes as usize,
        )
        .map_err(EncodeError::Platform)?;
        Ok(Self {
            encoder: Some(encoder),
            video,
            frames,
            statistics: EncoderStatistics {
                encoder_name: "VideoToolbox H.264 hardware".into(),
                ..Default::default()
            },
        })
    }

    pub(crate) fn push_surface(
        &mut self,
        frame: u64,
        surface: &Surface,
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        if cancel.load(Ordering::Acquire) {
            self.cancel();
            return Err(EncodeError::Cancelled);
        }
        if frame != self.statistics.accepted_frames
            || frame >= self.frames
            || self.statistics.drain_completed
        {
            return Err(EncodeError::Invalid(
                "VideoToolbox frame sequence differs".into(),
            ));
        }
        let bytes = self
            .encoder
            .as_mut()
            .ok_or(EncodeError::Cancelled)?
            .push(surface, frame)
            .map_err(EncodeError::Platform)?;
        if cancel.load(Ordering::Acquire) {
            self.cancel();
            return Err(EncodeError::Cancelled);
        }
        let mut metadata = FrameClock::at(self.video.frame_rate, frame)?;
        metadata.payload_bytes = u32::try_from(bytes.len())
            .map_err(|_| EncodeError::Invalid("packet too large".into()))?;
        self.statistics.accepted_frames += 1;
        self.statistics.encoded_frames += 1;
        self.statistics.encoded_bytes += bytes.len() as u64;
        self.statistics.gpu_input_frames += 1;
        self.statistics.retired_gpu_frames += 1;
        self.statistics.peak_gpu_leases = 1;
        self.statistics.peak_inflight_frames = 1;
        Ok(vec![EncodedPacket { metadata, bytes }])
    }

    pub(crate) fn finish(
        &mut self,
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        if cancel.load(Ordering::Acquire) {
            self.cancel();
            return Err(EncodeError::Cancelled);
        }
        if self.encoder.is_none()
            || self.statistics.drain_completed
            || self.statistics.encoded_frames != self.frames
        {
            return Err(EncodeError::Invalid(
                "VideoToolbox drain is incomplete".into(),
            ));
        }
        self.statistics.drain_completed = true;
        self.encoder.take();
        Ok(Vec::new())
    }

    pub(crate) fn cancel(&mut self) {
        self.statistics.cancelled = true;
        self.encoder.take();
    }
}

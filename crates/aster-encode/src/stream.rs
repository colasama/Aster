use std::sync::atomic::AtomicBool;

use aster_render_ir::{AdapterLuid, ExportVideoConfig};
use clap::Args;
use serde::Serialize;

use crate::{EncodeError, EncoderProbeLimits, timing::FrameClock};

#[derive(Clone, Debug, Args)]
pub struct EncoderOptions {
    #[command(flatten)]
    pub probe: EncoderProbeLimits,
    #[arg(long, default_value_t = 4)]
    pub max_encoder_inflight_frames: u32,
    #[arg(long, default_value_t = 134_217_728)]
    pub encoder_inflight_byte_budget: u64,
    #[arg(long, default_value_t = 16_777_216)]
    pub max_encoder_packet_bytes: u32,
    #[arg(long, default_value_t = 67_108_864)]
    pub max_encoder_batch_bytes: u64,
    #[arg(long, default_value_t = 1_000_000)]
    pub max_encoder_frames: u64,
    #[arg(long, default_value_t = 30_000)]
    pub encoder_timeout_ms: u64,
}

impl EncoderOptions {
    pub(crate) fn validate(
        &self,
        video: &ExportVideoConfig,
        frames: u64,
    ) -> Result<(), EncodeError> {
        self.probe.validate(video)?;
        let frame_bytes = u64::from(video.size.width) * u64::from(video.size.height) * 3 / 2;
        if !(1..=32).contains(&self.max_encoder_inflight_frames)
            || frame_bytes * u64::from(self.max_encoder_inflight_frames)
                > self.encoder_inflight_byte_budget
            || self.max_encoder_packet_bytes == 0
            || u64::from(self.max_encoder_packet_bytes) > self.max_encoder_batch_bytes
            || self.max_encoder_batch_bytes > u64::from(u32::MAX)
            || frames == 0
            || frames > self.max_encoder_frames
            || self.encoder_timeout_ms == 0
            || self.encoder_timeout_ms > 120_000
        {
            return Err(EncodeError::Invalid("encoder stream limits".into()));
        }
        FrameClock::at(video.frame_rate, frames)?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct PacketMetadata {
    pub frame_index: u64,
    pub timestamp_100ns: i64,
    pub duration_100ns: i64,
    pub payload_bytes: u32,
}

pub struct EncodedPacket {
    pub metadata: PacketMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct EncoderStatistics {
    pub encoder_name: String,
    pub accepted_frames: u64,
    pub encoded_frames: u64,
    pub encoded_bytes: u64,
    pub peak_inflight_frames: u32,
    pub gpu_input_frames: u64,
    pub retired_gpu_frames: u64,
    pub peak_gpu_leases: u32,
    pub drain_completed: bool,
    pub cancelled: bool,
}

pub struct HardwareEncoder {
    #[cfg(windows)]
    stream: crate::mf_stream::MfEncoder,
}

impl HardwareEncoder {
    pub fn new(
        luid: AdapterLuid,
        video: ExportVideoConfig,
        frames: u64,
        options: EncoderOptions,
    ) -> Result<Self, EncodeError> {
        options.validate(&video, frames)?;
        #[cfg(windows)]
        {
            Ok(Self {
                stream: crate::mf_stream::MfEncoder::new(luid, video, frames, options, false)?,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = luid;
            Err(EncodeError::Unsupported(
                "Media Foundation requires Windows".into(),
            ))
        }
    }

    pub fn push(
        &mut self,
        frame: u64,
        nv12: &[u8],
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        #[cfg(windows)]
        {
            self.stream.push(frame, nv12, cancel)
        }
        #[cfg(not(windows))]
        {
            let _ = (frame, nv12, cancel);
            Err(EncodeError::Unsupported(
                "Media Foundation requires Windows".into(),
            ))
        }
    }

    #[cfg(windows)]
    pub fn new_shared(
        luid: AdapterLuid,
        video: ExportVideoConfig,
        frames: u64,
        options: EncoderOptions,
    ) -> Result<Self, EncodeError> {
        options.validate(&video, frames)?;
        Ok(Self {
            stream: crate::mf_stream::MfEncoder::new(luid, video, frames, options, true)?,
        })
    }

    #[cfg(windows)]
    pub fn push_shared<F: std::os::windows::io::AsHandle + Send + Sync + 'static>(
        &mut self,
        frame: u64,
        surface: F,
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        self.stream.push_shared(frame, surface, cancel)
    }

    pub fn finish(&mut self, cancel: &AtomicBool) -> Result<Vec<EncodedPacket>, EncodeError> {
        #[cfg(windows)]
        {
            self.stream.finish(cancel)
        }
        #[cfg(not(windows))]
        {
            let _ = cancel;
            Err(EncodeError::Unsupported(
                "Media Foundation requires Windows".into(),
            ))
        }
    }

    pub fn cancel(&mut self) {
        #[cfg(windows)]
        self.stream.cancel();
    }

    pub fn statistics(&self) -> EncoderStatistics {
        #[cfg(windows)]
        {
            self.stream.statistics.clone()
        }
        #[cfg(not(windows))]
        {
            EncoderStatistics::default()
        }
    }
}

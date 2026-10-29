use aster_render_ir::{AdapterLuid, DecodeLimits, ExportVideoConfig};
use clap::Args;
use serde::Serialize;

#[cfg(windows)]
mod media_foundation;
#[cfg(windows)]
mod mf_events;
#[cfg(windows)]
mod mf_gpu;
#[cfg(windows)]
mod mf_packet;
#[cfg(windows)]
mod mf_quality;
#[cfg(windows)]
mod mf_stream;
#[cfg(windows)]
mod probe_stream;
mod stream;
mod timing;
#[cfg(target_os = "macos")]
mod videotoolbox;

pub use stream::{
    EncodedPacket, EncoderOptions, EncoderStatistics, HardwareEncoder, PacketMetadata,
};

#[derive(Clone, Debug, Args)]
pub struct EncoderProbeLimits {
    #[arg(long, default_value_t = 32)]
    pub max_hardware_encoders: usize,
    #[arg(long, default_value_t = 67_108_864)]
    pub max_encoder_input_bytes: u64,
    #[arg(long, default_value_t = 30_000)]
    pub encoder_probe_timeout_ms: u64,
    #[arg(long, default_value_t = 3)]
    pub encoder_probe_frames: u32,
    /// Optional hardware quality/speed override; omitted values retain the driver default.
    #[arg(long, value_parser = clap::value_parser!(u32).range(0..=100))]
    pub encoder_quality_vs_speed: Option<u32>,
    /// Media Foundation rate mode: 0 CBR, 1 peak-constrained VBR, 2 unconstrained VBR.
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(0..=2))]
    pub encoder_rate_control: u32,
    /// Bound quantization while the rate controller establishes its initial complexity estimate.
    #[arg(long, default_value = "18", value_parser = clap::value_parser!(u32).range(0..=51))]
    pub encoder_max_qp: Option<u32>,
    /// Tighten the quantization ceiling when the requested bitrate has ample spatial budget.
    #[arg(long, default_value_t = 12, value_parser = clap::value_parser!(u32).range(0..=51))]
    pub encoder_high_budget_max_qp: u32,
    #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u32).range(1..=24))]
    pub encoder_high_budget_bits_per_pixel: u32,
    #[arg(long, value_parser = clap::value_parser!(u32).range(1..=10000))]
    pub encoder_gop_frames: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error(transparent)]
    Config(#[from] aster_render_ir::IrError),
    #[error("hardware encoding unsupported: {0}")]
    Unsupported(String),
    #[error("hardware encoder failure: {0}")]
    Platform(String),
    #[error("invalid encoder operation: {0}")]
    Invalid(String),
    #[error("hardware encoding cancelled")]
    Cancelled,
    #[error("hardware encoder timed out")]
    TimedOut,
}

#[derive(Debug, Serialize)]
pub struct HardwareEncoderCandidate {
    pub name: String,
    pub configuration_accepted: bool,
    pub reason: Option<String>,
    pub encoded_proof: Option<EncodedProbeProof>,
}

#[derive(Debug, Serialize)]
pub struct EncodedProbeProof {
    pub frames: u32,
    pub packets: u32,
    pub encoded_bytes: u64,
    pub ordered_timestamps: bool,
    pub annex_b: bool,
    pub drain_completed: bool,
}

#[derive(Debug, Serialize)]
pub struct HardwareEncoderProbe {
    pub adapter_luid: AdapterLuid,
    pub hardware_only: bool,
    pub candidates: Vec<HardwareEncoderCandidate>,
    pub test_frame_verified: bool,
}

impl EncoderProbeLimits {
    pub(crate) fn validate(&self, video: &ExportVideoConfig) -> Result<(), EncodeError> {
        video.validate(&DecodeLimits::default())?;
        let bytes = u64::from(video.size.width) * u64::from(video.size.height) * 3 / 2;
        if self.max_hardware_encoders == 0
            || self.max_hardware_encoders > 256
            || bytes > self.max_encoder_input_bytes
            || bytes > u64::from(u32::MAX)
            || self.encoder_probe_timeout_ms == 0
            || self.encoder_probe_timeout_ms > 120_000
            || !(1..=16).contains(&self.encoder_probe_frames)
            || self
                .encoder_quality_vs_speed
                .is_some_and(|value| value > 100)
            || self.encoder_rate_control > 2
            || self.encoder_max_qp.is_some_and(|value| value > 51)
            || self.encoder_high_budget_max_qp > 51
            || !(1..=24).contains(&self.encoder_high_budget_bits_per_pixel)
            || self
                .encoder_gop_frames
                .is_some_and(|value| !(1..=10000).contains(&value))
        {
            return Err(EncodeError::Unsupported(
                "encoder probe allocation limits".into(),
            ));
        }
        Ok(())
    }
}

impl HardwareEncoderProbe {
    /// Require bounded, ordered Annex-B output from adapter-matched hardware transforms.
    pub fn inspect(
        luid: AdapterLuid,
        video: &ExportVideoConfig,
        limits: &EncoderProbeLimits,
    ) -> Result<Self, EncodeError> {
        limits.validate(video)?;
        #[cfg(windows)]
        {
            media_foundation::MfRuntime::probe(luid, video, limits)
        }
        #[cfg(not(windows))]
        {
            let _ = luid;
            Err(EncodeError::Unsupported(
                "Media Foundation requires Windows".into(),
            ))
        }
    }
}

#[cfg(windows)]
impl From<windows::core::Error> for EncodeError {
    fn from(error: windows::core::Error) -> Self {
        Self::Platform(error.to_string())
    }
}

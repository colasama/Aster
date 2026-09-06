use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum VideoError {
    #[error("timebase numerator and denominator must be positive")]
    InvalidTimebase,
    #[error("timestamp arithmetic overflowed")]
    TimestampOverflow,
    #[error("probe metadata exceeds the configured byte limit")]
    ProbeTooLarge,
    #[error("probe metadata is invalid: {0}")]
    InvalidProbe(String),
    #[error("no usable video stream was found")]
    NoVideoStream,
    #[error("invalid frame layout: {0}")]
    InvalidFrameLayout(&'static str),
}

/// Seconds per media timestamp tick, retained as an exact rational.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "RawTimebase")]
pub struct Timebase {
    pub numerator: u32,
    pub denominator: u32,
}

impl Timebase {
    const fn gcd(mut left: u32, mut right: u32) -> u32 {
        while right != 0 {
            let remainder = left % right;
            left = right;
            right = remainder;
        }
        left
    }

    pub fn new(numerator: u32, denominator: u32) -> Result<Self, VideoError> {
        if numerator == 0 || denominator == 0 {
            return Err(VideoError::InvalidTimebase);
        }
        let divisor = Self::gcd(numerator, denominator);
        Ok(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    /// Rescale a timestamp without passing through floating point.
    pub fn rescale(self, timestamp: i64, destination: Self) -> Result<i64, VideoError> {
        Self::new(self.numerator, self.denominator)?;
        Self::new(destination.numerator, destination.denominator)?;
        let value = i128::from(timestamp)
            .checked_mul(i128::from(self.numerator))
            .and_then(|value| value.checked_mul(i128::from(destination.denominator)))
            .ok_or(VideoError::TimestampOverflow)?;
        let divisor = i128::from(self.denominator) * i128::from(destination.numerator);
        let scaled = value / divisor;
        i64::try_from(scaled).map_err(|_| VideoError::TimestampOverflow)
    }

    pub fn seconds(self, timestamp: i64) -> Result<f64, VideoError> {
        Self::new(self.numerator, self.denominator)?;
        Ok(timestamp as f64 * f64::from(self.numerator) / f64::from(self.denominator))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Video,
    Audio,
    Subtitle,
    Data,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ColorPrimaries {
    Bt709,
    Bt2020,
    DisplayP3,
    #[default]
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransferFunction {
    Srgb,
    Bt709,
    Pq,
    Hlg,
    Linear,
    #[default]
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MatrixCoefficients {
    Identity,
    Bt709,
    Bt2020NonConstant,
    #[default]
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorMetadata {
    #[serde(default)]
    pub primaries: ColorPrimaries,
    #[serde(default)]
    pub transfer: TransferFunction,
    #[serde(default)]
    pub matrix: MatrixCoefficients,
    #[serde(default)]
    pub full_range: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamMetadata {
    pub index: u32,
    pub kind: StreamKind,
    pub codec: String,
    pub timebase: Timebase,
    #[serde(default)]
    pub default: bool,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub frame_rate: Option<Timebase>,
    #[serde(default)]
    pub sample_rate: u32,
    #[serde(default)]
    pub channels: u8,
    #[serde(default)]
    pub color: ColorMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerMetadata {
    pub format: String,
    pub duration_ticks: i64,
    pub timebase: Timebase,
    pub streams: Vec<StreamMetadata>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawTimebase {
    numerator: u32,
    denominator: u32,
}
impl TryFrom<RawTimebase> for Timebase {
    type Error = VideoError;
    fn try_from(raw: RawTimebase) -> Result<Self, Self::Error> {
        Self::new(raw.numerator, raw.denominator)
    }
}

#[derive(Debug, Clone, clap::Args)]
pub struct MetadataLimits {
    #[arg(long, default_value_t = Self::default().max_probe_bytes)]
    pub max_probe_bytes: usize,
    #[arg(long, default_value_t = Self::default().max_streams)]
    pub max_streams: usize,
    #[arg(long, default_value_t = Self::default().max_dimension)]
    pub max_dimension: u32,
}
impl Default for MetadataLimits {
    fn default() -> Self {
        Self {
            max_probe_bytes: 1024 * 1024,
            max_streams: 128,
            max_dimension: 32_768,
        }
    }
}

impl ContainerMetadata {
    /// Parse bounded metadata and validate it before allocation or use.
    pub fn parse(bytes: &[u8], limits: &MetadataLimits) -> Result<ContainerMetadata, VideoError> {
        if bytes.len() > limits.max_probe_bytes {
            return Err(VideoError::ProbeTooLarge);
        }
        let metadata: ContainerMetadata = serde_json::from_slice(bytes)
            .map_err(|error| VideoError::InvalidProbe(error.to_string()))?;
        metadata.validate(limits)?;
        Ok(metadata)
    }
}

impl ContainerMetadata {
    pub fn validate(&self, limits: &MetadataLimits) -> Result<(), VideoError> {
        if self.format.is_empty() || self.format.len() > 64 {
            return Err(VideoError::InvalidProbe("invalid format name".into()));
        }
        if self.duration_ticks < 0 {
            return Err(VideoError::InvalidProbe("negative duration".into()));
        }
        if self.streams.len() > limits.max_streams {
            return Err(VideoError::InvalidProbe("too many streams".into()));
        }
        Timebase::new(self.timebase.numerator, self.timebase.denominator)?;
        let mut indices = std::collections::BTreeSet::new();
        for stream in &self.streams {
            if !indices.insert(stream.index) {
                return Err(VideoError::InvalidProbe("duplicate stream index".into()));
            }
            if stream.codec.is_empty() || stream.codec.len() > 64 {
                return Err(VideoError::InvalidProbe("invalid codec name".into()));
            }
            Timebase::new(stream.timebase.numerator, stream.timebase.denominator)?;
            if let Some(frame_rate) = stream.frame_rate {
                Timebase::new(frame_rate.numerator, frame_rate.denominator)?;
            }
            if stream.kind == StreamKind::Video
                && (stream.width == 0
                    || stream.height == 0
                    || stream.width > limits.max_dimension
                    || stream.height > limits.max_dimension)
            {
                return Err(VideoError::InvalidProbe("invalid video dimensions".into()));
            }
            if stream.kind == StreamKind::Audio
                && (!(8_000..=384_000).contains(&stream.sample_rate)
                    || !(1..=32).contains(&stream.channels))
            {
                return Err(VideoError::InvalidProbe("invalid audio metadata".into()));
            }
        }
        Ok(())
    }
}

impl ContainerMetadata {
    pub fn select_video_stream(&self) -> Result<&StreamMetadata, VideoError> {
        self.streams
            .iter()
            .filter(|stream| stream.kind == StreamKind::Video)
            .max_by(|left, right| {
                let left_pixels = u64::from(left.width) * u64::from(left.height);
                let right_pixels = u64::from(right.width) * u64::from(right.height);
                left.default
                    .cmp(&right.default)
                    .then(left_pixels.cmp(&right_pixels))
                    .then_with(|| left.frame_rate_score().cmp(&right.frame_rate_score()))
                    .then_with(|| right.index.cmp(&left.index))
            })
            .ok_or(VideoError::NoVideoStream)
    }
}

impl ContainerMetadata {
    pub fn select_audio_stream(&self) -> Result<&StreamMetadata, VideoError> {
        self.streams
            .iter()
            .filter(|stream| stream.kind == StreamKind::Audio)
            .max_by(|left, right| {
                left.default
                    .cmp(&right.default)
                    .then(left.channels.cmp(&right.channels))
                    .then(left.sample_rate.cmp(&right.sample_rate))
                    .then_with(|| right.index.cmp(&left.index))
            })
            .ok_or(VideoError::InvalidProbe(
                "no usable audio stream was found".into(),
            ))
    }
}

impl StreamMetadata {
    fn frame_rate_score(&self) -> u64 {
        self.frame_rate.map_or(0, |rate| {
            u64::from(rate.denominator)
                .saturating_mul(1_000_000)
                .checked_div(u64::from(rate.numerator))
                .unwrap_or(0)
        })
    }
}

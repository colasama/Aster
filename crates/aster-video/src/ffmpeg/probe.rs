use super::*;

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    format: RawFormat,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
struct RawFormat {
    format_name: String,
    #[serde(default)]
    duration: Option<String>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
#[cfg_attr(test, derive(Default))]
struct RawStream {
    index: u32,
    codec_type: String,
    #[serde(default)]
    codec_name: Option<String>,
    #[serde(default)]
    time_base: Option<String>,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(default)]
    avg_frame_rate: Option<String>,
    #[serde(default)]
    sample_rate: Option<String>,
    #[serde(default)]
    channels: u8,
    #[serde(default)]
    color_primaries: Option<String>,
    #[serde(default)]
    color_transfer: Option<String>,
    #[serde(default)]
    color_space: Option<String>,
    #[serde(default)]
    color_range: Option<String>,
    #[serde(default)]
    disposition: RawDisposition,
}

#[derive(Debug, Default, Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
struct RawDisposition {
    #[serde(default)]
    default: u8,
}

impl ProbeLimits {
    pub fn parse_ffprobe_json(&self, bytes: &[u8]) -> Result<ContainerMetadata, FfprobeError> {
        if bytes.len() > self.metadata.max_probe_bytes {
            return Err(FfprobeError::OutputTooLarge {
                stream: "stdout",
                limit: self.metadata.max_probe_bytes,
            });
        }
        let raw: RawProbe = serde_json::from_slice(bytes)
            .map_err(|error| FfprobeError::InvalidMetadata(error.to_string()))?;
        if raw.streams.len() > self.metadata.max_streams {
            return Err(FfprobeError::InvalidMetadata("too many streams".into()));
        }
        let duration_ticks = RawFormat::parse_duration_ticks(raw.format.duration.as_deref())?;
        let streams = raw
            .streams
            .into_iter()
            .map(RawStream::convert)
            .collect::<Result<Vec<_>, _>>()?;
        let metadata = ContainerMetadata {
            format: RawFormat::normalize_token(
                raw.format.format_name.split(',').next().unwrap_or_default(),
                "format",
            )?,
            duration_ticks,
            timebase: Timebase::new(1, RawFormat::TIMEBASE_DENOMINATOR)
                .map_err(FfprobeError::from)?,
            streams,
        };
        metadata
            .validate(&self.metadata)
            .map_err(FfprobeError::from)?;
        Ok(metadata)
    }
}

impl RawStream {
    fn convert(self) -> Result<StreamMetadata, FfprobeError> {
        let timebase = match self.time_base.as_deref() {
            Some(value) if value != "N/A" => Timebase::parse_rational(value, false)?,
            _ => Timebase::new(1, RawFormat::TIMEBASE_DENOMINATOR).map_err(FfprobeError::from)?,
        };
        let frame_rate = match self.avg_frame_rate.as_deref() {
            None | Some("0/0") | Some("N/A") => None,
            Some(value) => Some(Timebase::parse_rational(value, true)?),
        };
        Ok(StreamMetadata {
            index: self.index,
            kind: match self.codec_type.as_str() {
                "video" => StreamKind::Video,
                "audio" => StreamKind::Audio,
                "subtitle" => StreamKind::Subtitle,
                _ => StreamKind::Data,
            },
            codec: RawFormat::normalize_token(
                self.codec_name.as_deref().unwrap_or("unknown"),
                "codec",
            )?,
            timebase,
            default: self.disposition.default != 0,
            width: self.width,
            height: self.height,
            frame_rate,
            sample_rate: match self.sample_rate.as_deref() {
                None | Some("N/A") => 0,
                Some(value) => value.parse::<u32>().map_err(|_| {
                    FfprobeError::InvalidMetadata("invalid audio sample rate".into())
                })?,
            },
            channels: self.channels,
            color: ColorMetadata {
                primaries: match self.color_primaries.as_deref() {
                    Some("bt709") => ColorPrimaries::Bt709,
                    Some("bt2020") => ColorPrimaries::Bt2020,
                    Some("smpte432") => ColorPrimaries::DisplayP3,
                    _ => ColorPrimaries::Unspecified,
                },
                transfer: match self.color_transfer.as_deref() {
                    Some("iec61966-2-1") => TransferFunction::Srgb,
                    Some("bt709" | "bt601" | "smpte170m") => TransferFunction::Bt709,
                    Some("smpte2084") => TransferFunction::Pq,
                    Some("arib-std-b67") => TransferFunction::Hlg,
                    Some("linear") => TransferFunction::Linear,
                    _ => TransferFunction::Unspecified,
                },
                matrix: match self.color_space.as_deref() {
                    Some("gbr" | "rgb") => MatrixCoefficients::Identity,
                    Some("bt709") => MatrixCoefficients::Bt709,
                    Some("bt2020nc") => MatrixCoefficients::Bt2020NonConstant,
                    _ => MatrixCoefficients::Unspecified,
                },
                full_range: matches!(self.color_range.as_deref(), Some("pc" | "jpeg")),
            },
        })
    }
}

impl RawFormat {
    fn parse_duration_ticks(duration: Option<&str>) -> Result<i64, FfprobeError> {
        let Some(duration) = duration.filter(|value| *value != "N/A") else {
            return Ok(0);
        };
        let seconds = duration
            .parse::<f64>()
            .map_err(|_| FfprobeError::InvalidMetadata("invalid duration".into()))?;
        if !seconds.is_finite() || seconds < 0.0 {
            return Err(FfprobeError::InvalidMetadata("invalid duration".into()));
        }
        let ticks = seconds * f64::from(RawFormat::TIMEBASE_DENOMINATOR);
        if ticks > i64::MAX as f64 {
            return Err(FfprobeError::InvalidMetadata("duration overflow".into()));
        }
        Ok(ticks.round() as i64)
    }
}

impl Timebase {
    fn parse_rational(value: &str, reciprocal: bool) -> Result<Timebase, FfprobeError> {
        let (left, right) = value
            .split_once('/')
            .ok_or_else(|| FfprobeError::InvalidMetadata("invalid rational".into()))?;
        let numerator = left
            .parse::<u32>()
            .map_err(|_| FfprobeError::InvalidMetadata("invalid rational".into()))?;
        let denominator = right
            .parse::<u32>()
            .map_err(|_| FfprobeError::InvalidMetadata("invalid rational".into()))?;
        let (numerator, denominator) = if reciprocal {
            (denominator, numerator)
        } else {
            (numerator, denominator)
        };
        Timebase::new(numerator, denominator).map_err(FfprobeError::from)
    }
}

impl RawFormat {
    fn normalize_token(value: &str, field: &'static str) -> Result<String, FfprobeError> {
        if value.is_empty()
            || value.len() > 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        {
            return Err(FfprobeError::InvalidMetadata(format!(
                "invalid {field} name"
            )));
        }
        Ok(value.to_owned())
    }
}

impl RawFormat {
    const TIMEBASE_DENOMINATOR: u32 = 1_000_000_000;
}

#[cfg(test)]
impl ProbeLimits {
    pub(super) fn fixture_bytes(duration: &str) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(&RawProbe {
            format: RawFormat {
                format_name: "mov,mp4,m4a,3gp,3g2,mj2".into(),
                duration: Some(duration.into()),
            },
            streams: vec![
                RawStream {
                    index: 0,
                    codec_name: Some("hevc".into()),
                    codec_type: "video".into(),
                    width: 3840,
                    height: 2160,
                    time_base: Some("1/90000".into()),
                    avg_frame_rate: Some("30000/1001".into()),
                    color_range: Some("pc".into()),
                    color_space: Some("bt2020nc".into()),
                    color_transfer: Some("smpte2084".into()),
                    color_primaries: Some("bt2020".into()),
                    disposition: RawDisposition { default: 1 },
                    ..RawStream::default()
                },
                RawStream {
                    index: 1,
                    codec_name: Some("aac".into()),
                    codec_type: "audio".into(),
                    time_base: Some("1/48000".into()),
                    sample_rate: Some("48000".into()),
                    channels: 2,
                    ..RawStream::default()
                },
            ],
        })
    }
}

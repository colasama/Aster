use crate::{CancellationToken, ContainerMetadata, FfmpegError, FfprobeBackend};
use serde::Deserialize;
use std::{collections::BTreeMap, path::Path};

#[derive(Clone, Copy, Debug, Deserialize)]
pub enum AudioSampleFormat {
    #[serde(rename = "u8", alias = "u8p")]
    Unsigned8,
    #[serde(rename = "s16", alias = "s16p")]
    Signed16,
    #[serde(rename = "s32", alias = "s32p")]
    Signed32,
    #[serde(rename = "flt", alias = "fltp")]
    Float32,
    #[serde(rename = "dbl", alias = "dblp")]
    Float64,
    #[serde(rename = "s64", alias = "s64p")]
    Signed64,
}

/// Source sample formats describe integer normalization before any requested resampling.
pub struct AudioProbe {
    pub metadata: ContainerMetadata,
    pub formats: BTreeMap<u32, AudioSampleFormat>,
}

#[derive(Deserialize)]
struct ProbeStreams {
    streams: Vec<ProbeStream>,
}
#[derive(Deserialize)]
struct ProbeStream {
    index: u32,
    sample_fmt: Option<AudioSampleFormat>,
}

impl FfprobeBackend {
    pub fn probe_audio(
        &self,
        path: &Path,
        cancellation: &CancellationToken,
    ) -> Result<AudioProbe, FfmpegError> {
        let bytes = self.probe_bytes(path, cancellation)?;
        let metadata = self.limits.parse_ffprobe_json(&bytes)?;
        let streams: ProbeStreams = serde_json::from_slice(&bytes)
            .map_err(|e| FfmpegError::InvalidMetadata(e.to_string()))?;
        let formats = streams
            .streams
            .into_iter()
            .filter_map(|s| s.sample_fmt.map(|f| (s.index, f)))
            .collect();
        Ok(AudioProbe { metadata, formats })
    }
}

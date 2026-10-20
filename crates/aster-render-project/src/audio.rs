use crate::audio_resample::AudioResampler;
use crate::{NativeProjectDocument, ProjectRenderError};
use aster_eval::{
    AudioAnalysis, AudioAnalysisLimits, AudioMix, AudioMixLimits, AudioMixRequest, AudioPcm,
    CompositionAudioReader,
};
use aster_media_native::ProjectMediaTools;
use aster_project::MediaSourceReader;
use aster_storage::AtomicFile;
use aster_video::{
    AudioDecodeRequest, CancellationToken, DecodeLimits, FfmpegBackend, FfprobeBackend,
    ProbeLimits, StreamKind,
};
use serde::Serialize;
use std::{collections::BTreeMap, io::Write, sync::Arc};

#[derive(Clone, Debug, clap::Args)]
pub struct ProjectAudioLimits {
    #[arg(long, default_value_t = 268_435_456)]
    pub project_audio_pcm_bytes: usize,
    #[arg(long, default_value_t = 256)]
    pub project_audio_sources: usize,
    #[arg(long, default_value_t = 536_870_912)]
    pub project_audio_source_bytes: u64,
    #[arg(long, default_value_t = 30_000)]
    pub project_audio_timeout_ms: u64,
    #[arg(long, default_value_t = 300.0)]
    pub project_audio_max_seconds: f64,
    #[command(flatten)]
    pub mix: AudioMixLimits,
}

#[derive(Debug, Serialize)]
pub struct ProjectAudioReceipt {
    pub source_id: String,
    pub content_sha256: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: usize,
}

/// Owns immutable decoded PCM for one composition; every analysis frame is time-addressable.
pub struct NativeProjectAudio {
    pub(crate) project_sha256: String,
    pub(crate) composition_id: String,
    reader: CompositionAudioReader,
    analysis: AudioAnalysis,
    pub receipts: Vec<ProjectAudioReceipt>,
}

impl NativeProjectAudio {
    pub fn new(
        document: &NativeProjectDocument,
        composition: &str,
        tools: ProjectMediaTools,
        limits: ProjectAudioLimits,
        cancellation: &CancellationToken,
    ) -> Result<Self, ProjectRenderError> {
        let composition_id = composition.to_owned();
        let composition = document.scene.audio_composition(composition)?;
        if limits.project_audio_pcm_bytes == 0
            || limits.project_audio_pcm_bytes > 1_073_741_824
            || limits.project_audio_sources == 0
            || limits.project_audio_sources > 4096
            || composition.sources.len() > limits.project_audio_sources
            || limits.project_audio_source_bytes == 0
            || limits.project_audio_source_bytes > 2_147_483_648
            || !(1..=300_000).contains(&limits.project_audio_timeout_ms)
            || !limits.project_audio_max_seconds.is_finite()
            || !(0.0..=3600.0).contains(&limits.project_audio_max_seconds)
            || limits.project_audio_max_seconds == 0.
        {
            return Err(ProjectRenderError::Invalid(
                "audio admission budget exceeded".into(),
            ));
        }
        let mut reader = MediaSourceReader::new(&document.root, document.limits.sources.clone())?;
        let timeout = std::time::Duration::from_millis(limits.project_audio_timeout_ms);
        let probe = FfprobeBackend::with_limits(
            tools.ffprobe,
            ProbeLimits {
                max_media_bytes: limits.project_audio_source_bytes,
                timeout,
                ..ProbeLimits::default()
            },
        );
        let mut decoded = BTreeMap::new();
        let mut identities = BTreeMap::<String, Arc<AudioPcm>>::new();
        let mut receipts = Vec::new();
        let mut retained = 0_usize;
        for source in &composition.sources {
            if cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            let binding = document.catalog.bind(&source.source_id)?;
            let snapshot = binding.read(&mut reader, None, limits.project_audio_source_bytes)?;
            let identity = snapshot.sha256.clone();
            let pcm = if let Some(existing) = identities.get(&identity) {
                existing.clone()
            } else {
                let (staging, mut writer) =
                    AtomicFile::stage(&std::env::temp_dir().join("aster-project-audio"))?;
                writer.write_all(&snapshot.bytes)?;
                drop(writer);
                let inspected = probe.probe_audio(&staging.temporary, cancellation)?;
                let metadata = &inspected.metadata;
                let stream = metadata
                    .streams
                    .iter()
                    .find(|s| s.kind == StreamKind::Audio)
                    .ok_or_else(|| {
                        ProjectRenderError::Invalid("source contains no audio stream".into())
                    })?;
                let duration = metadata
                    .timebase
                    .seconds(metadata.duration_ticks)
                    .map_err(|e| ProjectRenderError::Invalid(e.to_string()))?;
                let remaining = limits.project_audio_pcm_bytes.saturating_sub(retained);
                let mut decode_limits = DecodeLimits {
                    max_audio_bytes: remaining,
                    max_media_bytes: limits.project_audio_source_bytes,
                    timeout,
                    ..DecodeLimits::default()
                };
                decode_limits.audio.max_audio_duration_seconds = limits.project_audio_max_seconds;
                let decoder = FfmpegBackend::with_limits(&tools.ffmpeg, decode_limits);
                // Preserve the first two source channels used by the retained mixer; forcing
                // stereo here would downmix multichannel input before its layer gains.
                let audio = decoder.decode_audio(
                    &staging.temporary,
                    stream,
                    AudioDecodeRequest {
                        start_seconds: 0.,
                        duration_seconds: duration,
                        sample_rate: stream.sample_rate,
                        channels: u16::from(stream.channels),
                    },
                    cancellation,
                )?;
                let sample_format = inspected.formats.get(&stream.index).ok_or_else(|| {
                    ProjectRenderError::Invalid("audio sample format absent".into())
                })?;
                let mut channels =
                    vec![Vec::with_capacity(audio.frame_count()); usize::from(audio.channels)];
                for frame in audio.samples.chunks_exact(usize::from(audio.channels)) {
                    for (channel, sample) in channels.iter_mut().zip(frame) {
                        channel.push(AudioResampler::normalize(*sample, *sample_format));
                    }
                }
                let pcm = AudioPcm {
                    sample_rate: audio.sample_rate,
                    channels,
                };
                drop(audio);
                let pcm = Arc::new(AudioResampler::convert(
                    pcm,
                    48000,
                    remaining,
                    cancellation,
                )?);
                retained = retained
                    .checked_add(pcm.validate(remaining)?)
                    .ok_or_else(|| {
                        ProjectRenderError::Invalid("audio byte total overflow".into())
                    })?;
                identities.insert(identity.clone(), pcm.clone());
                pcm
            };
            receipts.push(ProjectAudioReceipt {
                source_id: source.source_id.clone(),
                content_sha256: identity,
                sample_rate: pcm.sample_rate,
                channels: pcm.channels.len() as u16,
                frames: pcm.channels[0].len(),
            });
            decoded.insert(source.source_id.clone(), pcm);
        }
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        Ok(Self {
            project_sha256: document.authored_sha256.clone(),
            composition_id,
            reader: CompositionAudioReader {
                composition,
                decoded,
                limits: limits.mix,
            },
            analysis: AudioAnalysis::compile(&AudioAnalysisLimits::default())?,
            receipts,
        })
    }

    pub fn analysis_frame(
        &self,
        time: f64,
        cancellation: &CancellationToken,
    ) -> Result<Vec<f32>, ProjectRenderError> {
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        Ok(self.analysis.evaluate(
            if self.reader.composition.sources.is_empty() {
                None
            } else {
                Some(&self.reader)
            },
            time,
            0,
        )?)
    }

    pub fn mix(
        &self,
        request: &AudioMixRequest,
        cancellation: &CancellationToken,
    ) -> Result<AudioMix, ProjectRenderError> {
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        let output =
            self.reader
                .composition
                .mix(&self.reader.decoded, request, &self.reader.limits)?;
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        Ok(output)
    }
}

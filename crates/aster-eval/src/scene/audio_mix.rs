use super::{LayerClock, SceneProject};
use crate::{EvaluationError, MonoAudioReader};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Debug, clap::Args)]
pub struct AudioMixLimits {
    #[arg(long, default_value_t = 268_435_456)]
    pub audio_mix_bytes: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioPcm {
    pub sample_rate: u32,
    pub channels: Vec<Vec<f32>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipProtection {
    Normalize,
    Limit,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioMixRequest {
    pub start_time: f64,
    pub end_time: f64,
    pub sample_rate: u32,
    pub master_level_db: f64,
    pub clip_protection: ClipProtection,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMix {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
    pub frame_count: usize,
    pub peak: f64,
    pub protection_gain: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSourceRequest {
    pub source_id: String,
    pub duration: f64,
}

#[derive(Clone, Debug)]
struct AudioLayer {
    source_id: String,
    duration: f64,
    clock: LayerClock,
    out_point: f64,
    gain: [f64; 2],
    reversed: bool,
}

#[derive(Clone, Debug)]
pub struct AudioComposition {
    pub duration: f64,
    pub sources: Vec<AudioSourceRequest>,
    layers: Vec<AudioLayer>,
}

impl SceneProject {
    /// Audio solo groups and visibility are independent of the flattened visual scene.
    pub fn audio_composition(&self, id: &str) -> Result<AudioComposition, EvaluationError> {
        let index = *self
            .composition_indices
            .get(id)
            .ok_or_else(|| EvaluationError::InvalidScene("audio composition absent".into()))?;
        let composition = &self.project.compositions[index];
        let compiled = &self.compositions[index];
        let sources = self
            .project
            .sources
            .value()
            .into_iter()
            .flatten()
            .map(|s| (s.id.as_str(), s))
            .collect::<BTreeMap<_, _>>();
        let solo = ["audio", "video"]
            .map(|kind| composition.layers.iter().any(|l| l.kind == kind && l.solo));
        let mut requests = BTreeMap::new();
        let mut layers = Vec::new();
        for (layer, prepared) in composition.layers.iter().zip(&compiled.layers) {
            let group = match layer.kind.as_str() {
                "audio" => 0,
                "video" => 1,
                _ => continue,
            };
            if layer.audio_enabled.value() == Some(&false)
                || layer.audio.value().is_some_and(|a| a.muted)
                || (solo[group] && !layer.solo)
            {
                continue;
            }
            let Some(source) = layer
                .source_id
                .value()
                .and_then(|id| sources.get(id.as_str()))
            else {
                continue;
            };
            if !matches!(source.kind.as_str(), "audio" | "video")
                || (source.kind == "video" && source.audio.value().is_none())
            {
                continue;
            }
            let duration = source
                .duration
                .value()
                .map(Self::number)
                .transpose()?
                .ok_or_else(|| EvaluationError::InvalidScene("audio duration absent".into()))?;
            if duration < 0. {
                return Err(EvaluationError::InvalidScene(
                    "negative audio duration".into(),
                ));
            }
            let (gain, reversed) = if let Some(audio) = layer.audio.value() {
                let pan = Self::number(&audio.pan)?;
                (
                    [
                        AudioComposition::gain(Self::number(&audio.levels_db[0])?)
                            * (1. - pan.max(0.)).sqrt(),
                        AudioComposition::gain(Self::number(&audio.levels_db[1])?)
                            * (1. + pan.min(0.)).sqrt(),
                    ],
                    audio.reversed,
                )
            } else {
                ([1., 1.], false)
            };
            if gain.iter().any(|g| !g.is_finite()) {
                return Err(EvaluationError::InvalidScene("invalid audio gain".into()));
            }
            requests.insert(
                source.id.clone(),
                AudioSourceRequest {
                    source_id: source.id.clone(),
                    duration,
                },
            );
            layers.push(AudioLayer {
                source_id: source.id.clone(),
                duration,
                clock: prepared.clock.clone(),
                out_point: prepared.out_point,
                gain,
                reversed,
            });
        }
        Ok(AudioComposition {
            duration: compiled.duration,
            sources: requests.into_values().collect(),
            layers,
        })
    }
}

impl AudioPcm {
    pub fn validate(&self, maximum_bytes: usize) -> Result<usize, EvaluationError> {
        let frames = self.channels.first().map_or(0, Vec::len);
        let bytes = frames
            .checked_mul(self.channels.len())
            .and_then(|n| n.checked_mul(4));
        if !(8000..=192000).contains(&self.sample_rate)
            || !(1..=32).contains(&self.channels.len())
            || self.channels.iter().any(|c| c.len() != frames)
            || bytes.is_none_or(|n| n > maximum_bytes)
        {
            return Err(EvaluationError::InvalidScene(
                "invalid or oversized audio PCM".into(),
            ));
        }
        bytes.ok_or_else(|| EvaluationError::InvalidScene("audio size overflow".into()))
    }

    fn sample(&self, channel: usize, position: f64) -> f64 {
        let samples = &self.channels[channel.min(self.channels.len() - 1)];
        if samples.is_empty() {
            return 0.;
        }
        let first = (position.floor() as usize).min(samples.len() - 1);
        let second = (first + 1).min(samples.len() - 1);
        let left = if samples[first].is_finite() {
            f64::from(samples[first])
        } else {
            0.
        };
        let right = if samples[second].is_finite() {
            f64::from(samples[second])
        } else {
            0.
        };
        left + (right - left) * (position - first as f64)
    }
}

impl AudioComposition {
    fn gain(db: f64) -> f64 {
        if !db.is_finite() || db <= -192. {
            0.
        } else {
            10_f64.powf(db / 20.).min(16.)
        }
    }

    pub fn mix(
        &self,
        decoded: &BTreeMap<String, Arc<AudioPcm>>,
        request: &AudioMixRequest,
        limits: &AudioMixLimits,
    ) -> Result<AudioMix, EvaluationError> {
        if !(8000..=192000).contains(&request.sample_rate)
            || !request.start_time.is_finite()
            || !request.end_time.is_finite()
            || request.start_time < 0.
            || request.end_time <= request.start_time
            || request.end_time > self.duration
            || limits.audio_mix_bytes == 0
            || limits.audio_mix_bytes > 268_435_456
        {
            return Err(EvaluationError::InvalidScene(
                "invalid bounded audio mix range".into(),
            ));
        }
        let count =
            ((request.end_time - request.start_time) * f64::from(request.sample_rate)).ceil();
        if count > (limits.audio_mix_bytes / 8) as f64 {
            return Err(EvaluationError::InvalidScene(
                "audio mix output budget exceeded".into(),
            ));
        }
        let frame_count = count as usize;
        let mut samples = vec![0_f32; frame_count * 2];
        for layer in &self.layers {
            let Some(pcm) = decoded.get(&layer.source_id) else {
                continue;
            };
            pcm.validate(limits.audio_mix_bytes)?;
            let duration = layer
                .duration
                .min(pcm.channels[0].len() as f64 / f64::from(pcm.sample_rate));
            if duration <= 0. {
                continue;
            }
            for (frame, stereo) in samples.chunks_exact_mut(2).enumerate() {
                let time = request.start_time + frame as f64 / f64::from(request.sample_rate);
                if time < layer.clock.in_point || time >= layer.out_point {
                    continue;
                }
                let forward = layer.clock.evaluate(time, duration)?;
                let time = if layer.reversed {
                    (duration - forward).max(0.)
                } else {
                    forward
                };
                let position = (time * f64::from(pcm.sample_rate))
                    .max(0.)
                    .min(pcm.channels[0].len().saturating_sub(1) as f64);
                for (channel, value) in stereo.iter_mut().enumerate() {
                    *value = (f64::from(*value)
                        + pcm.sample(channel, position) * layer.gain[channel])
                        as f32;
                }
            }
        }
        let master = Self::gain(request.master_level_db);
        let mut peak = 0_f64;
        for sample in &mut samples {
            *sample = (f64::from(*sample) * master) as f32;
            peak = peak.max(f64::from(*sample).abs());
        }
        let protection_gain =
            if matches!(request.clip_protection, ClipProtection::Normalize) && peak > 1. {
                0.999 / peak
            } else {
                1.
            };
        if protection_gain < 1. {
            for sample in &mut samples {
                *sample = (f64::from(*sample) * protection_gain) as f32;
            }
        } else if matches!(request.clip_protection, ClipProtection::Limit) && peak > 1. {
            for sample in &mut samples {
                *sample = f64::from(*sample).clamp(-0.999, 0.999) as f32;
            }
        }
        Ok(AudioMix {
            samples,
            sample_rate: request.sample_rate,
            frame_count,
            peak,
            protection_gain,
        })
    }
}

pub struct CompositionAudioReader {
    pub composition: AudioComposition,
    pub decoded: BTreeMap<String, Arc<AudioPcm>>,
    pub limits: AudioMixLimits,
}

impl MonoAudioReader for CompositionAudioReader {
    fn read(&self, start_sample: i64, output: &mut [f32]) -> Result<(), EvaluationError> {
        output.fill(0.);
        let first = start_sample.max(0);
        let last = start_sample
            .checked_add(output.len() as i64)
            .ok_or(EvaluationError::InvalidTime)?
            .min((self.composition.duration * 48000.).floor() as i64);
        if self.decoded.is_empty() || last <= first {
            return Ok(());
        }
        let mixed = self.composition.mix(
            &self.decoded,
            &AudioMixRequest {
                start_time: first as f64 / 48000.,
                end_time: last as f64 / 48000.,
                sample_rate: 48000,
                master_level_db: 0.,
                clip_protection: ClipProtection::None,
            },
            &self.limits,
        )?;
        for (index, pair) in mixed
            .samples
            .chunks_exact(2)
            .take((last - first) as usize)
            .enumerate()
        {
            output[(first - start_sample) as usize + index] =
                ((f64::from(pair[0]) + f64::from(pair[1])) * 0.5) as f32;
        }
        Ok(())
    }
}

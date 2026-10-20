mod frame;
mod spectrum;

use crate::EvaluationError;
pub use frame::{AudioAnalysis, MonoAudioReader};
pub use spectrum::{SpectrumPlan, SpectrumWindow};

#[derive(Clone, Debug, clap::Args)]
pub struct AudioAnalysisLimits {
    #[arg(long, default_value_t = Self::default().max_fft_size)]
    pub max_fft_size: usize,
    #[arg(long, default_value_t = Self::default().max_waveform_bins)]
    pub max_waveform_bins: usize,
}

impl Default for AudioAnalysisLimits {
    fn default() -> Self {
        Self {
            max_fft_size: 32768,
            max_waveform_bins: 65536,
        }
    }
}

pub struct AudioSamples;

impl AudioSamples {
    pub fn waveform_peaks(
        samples: &[f32],
        bins: usize,
        limits: &AudioAnalysisLimits,
    ) -> Result<Vec<f32>, EvaluationError> {
        if bins == 0 || bins > limits.max_waveform_bins.min(65536) {
            return Err(EvaluationError::InvalidScene(
                "waveform bin budget exceeded".into(),
            ));
        }
        let mut output = vec![0.; bins * 4];
        for (bin, row) in output.chunks_exact_mut(4).enumerate() {
            let start = ((bin as f64 * samples.len() as f64) / bins as f64).floor() as usize;
            let end = (((bin + 1) as f64 * samples.len() as f64) / bins as f64).floor() as usize;
            if start == end {
                continue;
            }
            let mut minimum = f64::INFINITY;
            let mut maximum = f64::NEG_INFINITY;
            let mut square_sum = 0.;
            for sample in &samples[start..end] {
                let sample = if sample.is_finite() {
                    f64::from(*sample)
                } else {
                    0.
                };
                minimum = minimum.min(sample);
                maximum = maximum.max(sample);
                square_sum += sample * sample;
            }
            row.copy_from_slice(&[
                minimum as f32,
                maximum as f32,
                (square_sum / (end - start) as f64).sqrt() as f32,
                (end - start) as f32,
            ]);
        }
        Ok(output)
    }

    pub fn apply_volume(samples: &[f32], gain: f64, muted: bool) -> Vec<f32> {
        let gain = if muted {
            0.
        } else if gain.is_finite() {
            gain.clamp(0., 4.)
        } else {
            1.
        };
        samples
            .iter()
            .map(|sample| {
                if gain == 0. || !sample.is_finite() {
                    0.
                } else {
                    (f64::from(*sample) * gain) as f32
                }
            })
            .collect()
    }
}

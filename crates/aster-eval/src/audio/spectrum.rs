use super::AudioAnalysisLimits;
use crate::EvaluationError;
use serde::Deserialize;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpectrumWindow {
    Blackman,
    Hamming,
    Hann,
    Rectangular,
}

#[derive(Clone, Debug)]
pub struct SpectrumPlan {
    weights: Vec<f64>,
    normalization: f64,
    steps: Vec<[f64; 2]>,
}

impl SpectrumPlan {
    pub fn compile(
        size: usize,
        window: SpectrumWindow,
        limits: &AudioAnalysisLimits,
    ) -> Result<Self, EvaluationError> {
        if size < 2 || !size.is_power_of_two() || size > limits.max_fft_size.min(32768) {
            return Err(EvaluationError::InvalidScene(
                "invalid FFT size or budget".into(),
            ));
        }
        let weights: Vec<_> = (0..size)
            .map(|i| {
                let phase = 2. * std::f64::consts::PI * i as f64 / (size - 1) as f64;
                match window {
                    SpectrumWindow::Rectangular => 1.,
                    SpectrumWindow::Hann => 0.5 - 0.5 * phase.cos(),
                    SpectrumWindow::Hamming => 0.54 - 0.46 * phase.cos(),
                    SpectrumWindow::Blackman => {
                        0.42 - 0.5 * phase.cos() + 0.08 * (phase * 2.).cos()
                    }
                }
            })
            .collect();
        let gain: f64 = weights.iter().sum();
        let normalization = if gain > f64::EPSILON {
            1. / gain
        } else {
            1. / size as f64
        };
        let steps = (1..=size.ilog2())
            .map(|exponent| {
                let angle = -2. * std::f64::consts::PI / (1usize << exponent) as f64;
                [angle.cos(), angle.sin()]
            })
            .collect();
        Ok(Self {
            weights,
            normalization,
            steps,
        })
    }

    pub fn evaluate(
        &self,
        samples: &[f32],
        sample_rate: f64,
        start_sample: usize,
    ) -> Result<Vec<f32>, EvaluationError> {
        if !sample_rate.is_finite() || sample_rate <= 0. || start_sample as u64 > 9007199254740991 {
            return Err(EvaluationError::InvalidScene(
                "invalid spectrum rate or sample offset".into(),
            ));
        }
        let size = self.weights.len();
        let mut real: Vec<_> = self
            .weights
            .iter()
            .enumerate()
            .map(|(index, weight)| {
                let sample = start_sample
                    .checked_add(index)
                    .and_then(|i| samples.get(i))
                    .copied()
                    .unwrap_or(0.);
                if sample.is_finite() {
                    f64::from(sample) * weight
                } else {
                    0.
                }
            })
            .collect();
        let mut imaginary = vec![0.; size];
        let mut reversed = 0;
        for index in 1..size {
            let mut bit = size >> 1;
            while reversed & bit != 0 {
                reversed ^= bit;
                bit >>= 1;
            }
            reversed ^= bit;
            if index < reversed {
                real.swap(index, reversed);
                imaginary.swap(index, reversed);
            }
        }
        for (stage, [step_real, step_imaginary]) in self.steps.iter().copied().enumerate() {
            let length = 1 << (stage + 1);
            let half = length / 2;
            for offset in (0..size).step_by(length) {
                let (mut twiddle_real, mut twiddle_imaginary) = (1., 0.);
                for index in 0..half {
                    let even = offset + index;
                    let odd = even + half;
                    let odd_real = real[odd] * twiddle_real - imaginary[odd] * twiddle_imaginary;
                    let odd_imaginary =
                        real[odd] * twiddle_imaginary + imaginary[odd] * twiddle_real;
                    real[odd] = real[even] - odd_real;
                    imaginary[odd] = imaginary[even] - odd_imaginary;
                    real[even] += odd_real;
                    imaginary[even] += odd_imaginary;
                    let next_real = twiddle_real * step_real - twiddle_imaginary * step_imaginary;
                    twiddle_imaginary =
                        twiddle_real * step_imaginary + twiddle_imaginary * step_real;
                    twiddle_real = next_real;
                }
            }
        }
        let mut output = Vec::with_capacity((size / 2 + 1) * 4);
        for bin in 0..=size / 2 {
            let edge_scale = if bin == 0 || bin == size / 2 {
                self.normalization
            } else {
                self.normalization * 2.
            };
            let magnitude = real[bin].hypot(imaginary[bin]) * edge_scale;
            output.extend([
                (bin as f64 * sample_rate / size as f64) as f32,
                magnitude as f32,
                (magnitude * magnitude) as f32,
                imaginary[bin].atan2(real[bin]) as f32,
            ]);
        }
        Ok(output)
    }
}

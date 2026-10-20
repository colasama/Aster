use super::{AudioAnalysisLimits, SpectrumPlan, SpectrumWindow};
use crate::{EvaluationError, expression::NumericFunction};

/// Supplies mono 48 kHz composition PCM. Fill samples outside audible layers with zero.
pub trait MonoAudioReader {
    fn read(&self, start_sample: i64, output: &mut [f32]) -> Result<(), EvaluationError>;
}

#[derive(Clone, Debug)]
pub struct AudioAnalysis {
    spectrum: SpectrumPlan,
    edges: [f64; 129],
    frequencies: [f64; 128],
}

impl AudioAnalysis {
    pub fn compile(limits: &AudioAnalysisLimits) -> Result<Self, EvaluationError> {
        Ok(Self {
            spectrum: SpectrumPlan::compile(4096, SpectrumWindow::Hann, limits)?,
            edges: std::array::from_fn(|i| 30. * (16000_f64 / 30.).powf(i as f64 / 128.)),
            frequencies: std::array::from_fn(|i| {
                30. * (16000_f64 / 30.).powf((i as f64 + 0.5) / 128.)
            }),
        })
    }

    pub fn evaluate(
        &self,
        reader: Option<&dyn MonoAudioReader>,
        time: f64,
        flags: u32,
    ) -> Result<Vec<f32>, EvaluationError> {
        let mut output = vec![0.; 2320];
        output[..4].copy_from_slice(
            &[128, 16, 256, flags | u32::from(reader.is_some())].map(f32::from_bits),
        );
        output[4..8].copy_from_slice(&[
            if time.is_finite() { time as f32 } else { 0. },
            (1_f64 / 60.) as f32,
            30.,
            16000.,
        ]);
        let Some(reader) = reader.filter(|_| time.is_finite()) else {
            return Ok(output);
        };
        let center = NumericFunction::round(time * 48000.);
        if !center.is_finite() || center.abs() > 9007199254740991. - 32768. {
            return Err(EvaluationError::InvalidScene(
                "audio time outside exact sample range".into(),
            ));
        }
        let center = center as i64;
        let mut samples = vec![0.; 4096];
        for history in 0..16 {
            let frame_center =
                center - NumericFunction::round(history as f64 * (1. / 60.) * 48000.) as i64;
            Self::read(reader, frame_center - 2048, &mut samples)?;
            let spectrum = self.spectrum.evaluate(&samples, 48000., 0)?;
            let magnitude_at = |bin: usize| f64::from(spectrum[bin.min(2048) * 4 + 1]);
            for band in 0..128 {
                let low = self.edges[band] / (48000. / 4096.);
                let high = self.edges[band + 1] / (48000. / 4096.);
                let middle = (low * high).sqrt();
                let lower = middle.floor() as usize;
                let mut magnitude = magnitude_at(lower)
                    + (magnitude_at(lower + 1) - magnitude_at(lower)) * (middle - lower as f64);
                for bin in low.ceil() as usize..high.ceil() as usize {
                    magnitude = magnitude.max(magnitude_at(bin));
                }
                output[16 + history * 128 + band] = Self::decibels(magnitude, -90.) as f32;
            }
        }
        Self::read(reader, center - 1024, &mut samples[..2048])?;
        let mut square_sum = 0.;
        let mut peak: f64 = 0.;
        for sample in &samples[..2048] {
            let s = f64::from(*sample);
            square_sum += s * s;
            peak = peak.max(s.abs());
        }
        let rms = (square_sum / 2048.).sqrt();
        let flux: f64 = (0..128)
            .map(|i| (f64::from(output[16 + i]) - f64::from(output[144 + i])).max(0.))
            .sum();
        output[8..12].copy_from_slice(&[
            rms as f32,
            peak as f32,
            Self::decibels(rms, -60.) as f32,
            (flux / 128.) as f32,
        ]);
        for (index, (minimum, maximum)) in [(0., 250.), (250., 4000.), (4000., f64::INFINITY)]
            .into_iter()
            .enumerate()
        {
            let mut sum = 0.;
            let mut count = 0;
            for (band, frequency) in self.frequencies.iter().enumerate() {
                if *frequency >= minimum && *frequency < maximum {
                    sum += f64::from(output[16 + band]);
                    count += 1;
                }
            }
            output[12 + index] = if count == 0 {
                0.
            } else {
                (sum / f64::from(count)) as f32
            };
        }
        Self::read(reader, center - 512, &mut samples[..1024])?;
        for (index, chunk) in samples[..1024].chunks_exact(4).enumerate() {
            output[2064 + index] = (chunk.iter().map(|n| f64::from(*n)).sum::<f64>() / 4.) as f32;
        }
        Ok(output)
    }

    fn decibels(magnitude: f64, floor: f64) -> f64 {
        if magnitude > 0. {
            ((20. * magnitude.log10() - floor) / -floor).clamp(0., 1.)
        } else {
            0.
        }
    }

    fn read(
        reader: &dyn MonoAudioReader,
        start: i64,
        output: &mut [f32],
    ) -> Result<(), EvaluationError> {
        output.fill(0.);
        reader.read(start, output)?;
        if output.iter().any(|s| !s.is_finite()) {
            return Err(EvaluationError::InvalidScene(
                "nonfinite composition audio".into(),
            ));
        }
        Ok(())
    }
}

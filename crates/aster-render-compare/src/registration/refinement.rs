use rustfft::num_complex::Complex;

use super::{RegistrationOptions, spectrum::PhaseSpectrum};
use crate::error::CompareError;

pub(super) struct CorrelationPeak {
    x: usize,
    y: usize,
    pub ratio: f64,
    pub psr: f64,
    pub coherence: f64,
}

impl CorrelationPeak {
    pub fn locate(spectrum: &PhaseSpectrum, options: &RegistrationOptions) -> Self {
        let (mut peak_index, mut peak) = (0, 0.0);
        for (index, value) in spectrum.correlation.iter().enumerate() {
            if value.norm() > peak {
                peak = value.norm();
                peak_index = index;
            }
        }
        let (x, y) = (peak_index % spectrum.width, peak_index / spectrum.width);
        let (mut second, mut sum, mut squares, mut count) = (0.0_f64, 0.0, 0.0, 0_usize);
        for row in 0..spectrum.height {
            for col in 0..spectrum.width {
                let dx = col.abs_diff(x).min(spectrum.width - col.abs_diff(x));
                let dy = row.abs_diff(y).min(spectrum.height - row.abs_diff(y));
                if dx <= options.peak_exclusion_radius && dy <= options.peak_exclusion_radius {
                    continue;
                }
                let value = spectrum.correlation[row * spectrum.width + col].norm();
                sum += value;
                squares += value * value;
                count += 1;
                let local_maximum = (-1_isize..=1).all(|oy| {
                    (-1_isize..=1).all(|ox| {
                        let nx = (col as isize + ox).rem_euclid(spectrum.width as isize) as usize;
                        let ny = (row as isize + oy).rem_euclid(spectrum.height as isize) as usize;
                        spectrum.correlation[ny * spectrum.width + nx].norm() <= value
                    })
                });
                if local_maximum {
                    second = second.max(value);
                }
            }
        }
        let mean = sum / count.max(1) as f64;
        let deviation = (squares / count.max(1) as f64 - mean * mean)
            .max(0.0)
            .sqrt();
        Self {
            x,
            y,
            ratio: if count == 0 {
                0.0
            } else {
                peak / second.max(f64::EPSILON)
            },
            psr: if count == 0 {
                0.0
            } else {
                (peak - mean) / deviation.max(f64::EPSILON)
            },
            coherence: (peak * spectrum.values.len() as f64
                / spectrum.active_frequencies.max(1) as f64)
                .min(1.0),
        }
    }

    pub fn refine(
        &self,
        spectrum: &PhaseSpectrum,
        options: &RegistrationOptions,
    ) -> Result<(f64, f64), CompareError> {
        let x = Self::signed_frequency(self.x, spectrum.width);
        let y = Self::signed_frequency(self.y, spectrum.height);
        let coarse = Self::local_dft(spectrum, x, y, 1.0, 8)?;
        Self::local_dft(spectrum, coarse.0, coarse.1, 0.125, options.upsample_factor)
    }

    fn local_dft(
        spectrum: &PhaseSpectrum,
        center_x: f64,
        center_y: f64,
        radius: f64,
        factor: u32,
    ) -> Result<(f64, f64), CompareError> {
        let steps = (radius * f64::from(factor)).ceil() as usize;
        let size = steps * 2 + 1;
        let mut horizontal = PhaseSpectrum::buffer(spectrum.height * size)?;
        let mut kernel = PhaseSpectrum::buffer(spectrum.width * size)?;
        for index in 0..size {
            let x = center_x + (index as f64 - steps as f64) / f64::from(factor);
            for frequency in 0..spectrum.width {
                let angle =
                    std::f64::consts::TAU * Self::signed_frequency(frequency, spectrum.width) * x
                        / spectrum.width as f64;
                kernel[index * spectrum.width + frequency] = Complex::from_polar(1.0, angle);
            }
        }
        for row in 0..spectrum.height {
            for col in 0..spectrum.width {
                let value = spectrum.values[row * spectrum.width + col];
                if value.re == 0.0 && value.im == 0.0 {
                    continue;
                }
                for index in 0..size {
                    horizontal[row * size + index] += value * kernel[index * spectrum.width + col];
                }
            }
        }
        let (mut peak, mut position) = (-1.0_f64, (center_x, center_y));
        for iy in 0..size {
            let y = center_y + (iy as f64 - steps as f64) / f64::from(factor);
            let mut vertical = PhaseSpectrum::buffer(size)?;
            for row in 0..spectrum.height {
                let angle =
                    std::f64::consts::TAU * Self::signed_frequency(row, spectrum.height) * y
                        / spectrum.height as f64;
                let weight = Complex::from_polar(1.0, angle);
                for ix in 0..size {
                    vertical[ix] += horizontal[row * size + ix] * weight;
                }
            }
            for (ix, value) in vertical.iter().enumerate() {
                if value.norm_sqr() > peak {
                    peak = value.norm_sqr();
                    position = (center_x + (ix as f64 - steps as f64) / f64::from(factor), y);
                }
            }
        }
        Ok(position)
    }

    fn signed_frequency(index: usize, length: usize) -> f64 {
        if index < length.div_ceil(2) {
            index as f64
        } else {
            index as f64 - length as f64
        }
    }
}

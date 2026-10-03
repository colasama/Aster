use std::sync::Arc;

use rustfft::{Fft, FftPlanner, num_complex::Complex};

use super::RegistrationOptions;
use crate::{error::CompareError, image::RgbaImage};

pub(super) struct ImageSignal {
    means: [f64; 4],
    pub rms: f64,
    pub axis_ratio: f64,
    pub window_energy_fraction: f64,
}

impl ImageSignal {
    pub fn analyze(image: &RgbaImage, taper: f64) -> Self {
        let width = image.width as usize;
        let mut sums = [0.0; 4];
        let mut squares = [0.0; 4];
        let (mut xx, mut xy, mut yy) = (0.0, 0.0, 0.0);
        for (index, pixel) in image.pixels.chunks_exact(4).enumerate() {
            for channel in 0..4 {
                let value = f64::from(pixel[channel]) / 255.0;
                sums[channel] += value;
                squares[channel] += value * value;
                if index % width > 0 && index >= width {
                    let dx = value - f64::from(image.pixels[(index - 1) * 4 + channel]) / 255.0;
                    let dy = value - f64::from(image.pixels[(index - width) * 4 + channel]) / 255.0;
                    xx += dx * dx;
                    xy += dx * dy;
                    yy += dy * dy;
                }
            }
        }
        let count = f64::from(image.width) * f64::from(image.height);
        let means = sums.map(|sum| sum / count);
        let variance = squares
            .iter()
            .zip(means)
            .map(|(square, mean)| (square / count - mean * mean).max(0.0))
            .sum::<f64>()
            / 4.0;
        let trace = xx + yy;
        let minimum = (trace - (xx - yy).hypot(2.0 * xy)).max(0.0) * 0.5;
        let mut window_energy = 0.0;
        for (index, pixel) in image.pixels.chunks_exact(4).enumerate() {
            let weight = Self::window(index % width, width, taper)
                * Self::window(index / width, image.height as usize, taper);
            for channel in 0..4 {
                let centered = f64::from(pixel[channel]) / 255.0 - means[channel];
                window_energy += centered * centered * weight * weight;
            }
        }
        Self {
            means,
            rms: variance.sqrt(),
            axis_ratio: minimum / trace.max(f64::EPSILON),
            window_energy_fraction: (window_energy / (variance * count * 4.0).max(f64::EPSILON))
                .min(1.0),
        }
    }

    fn fill(
        &self,
        image: &RgbaImage,
        channel: usize,
        width: usize,
        buffer: &mut [Complex<f64>],
        taper: f64,
    ) {
        buffer.fill(Complex::default());
        for y in 0..image.height as usize {
            let wy = Self::window(y, image.height as usize, taper);
            for x in 0..image.width as usize {
                let value =
                    f64::from(image.pixels[(y * image.width as usize + x) * 4 + channel]) / 255.0;
                buffer[y * width + x].re = (value - self.means[channel])
                    * wy
                    * Self::window(x, image.width as usize, taper);
            }
        }
    }

    fn window(index: usize, length: usize, taper: f64) -> f64 {
        if taper == 0.0 || length <= 1 {
            return 1.0;
        }
        let edge = index.min(length - 1 - index) as f64 / (length - 1) as f64;
        if edge >= taper * 0.5 {
            1.0
        } else {
            0.5 * (1.0 - (std::f64::consts::TAU * edge / taper).cos())
        }
    }
}

pub(super) struct PhaseSpectrum {
    pub width: usize,
    pub height: usize,
    pub values: Vec<Complex<f64>>,
    pub correlation: Vec<Complex<f64>>,
    pub active_frequencies: usize,
    pub working_bytes: usize,
}

impl PhaseSpectrum {
    pub fn build(
        reference: &RgbaImage,
        candidate: &RgbaImage,
        reference_signal: &ImageSignal,
        candidate_signal: &ImageSignal,
        options: &RegistrationOptions,
    ) -> Result<Self, CompareError> {
        let width = (reference.width as usize)
            .checked_mul(2)
            .and_then(|n| n.checked_sub(1))
            .and_then(usize::checked_next_power_of_two);
        let height = (reference.height as usize)
            .checked_mul(2)
            .and_then(|n| n.checked_sub(1))
            .and_then(usize::checked_next_power_of_two);
        let (Some(width), Some(height)) = (width, height) else {
            return Err(CompareError::ResourceLimit(
                "padded phase dimensions overflow".to_owned(),
            ));
        };
        let count = width.checked_mul(height).ok_or_else(|| {
            CompareError::ResourceLimit("phase buffer dimensions overflow".to_owned())
        })?;
        let refinement_width = (options.upsample_factor as usize / 4 + 1).max(17);
        let working_bytes = count
            .checked_mul(3 * size_of::<Complex<f64>>())
            .and_then(|bytes| {
                (width + height)
                    .checked_mul((128 + refinement_width) * size_of::<Complex<f64>>())
                    .and_then(|scratch| bytes.checked_add(scratch))
            })
            .ok_or_else(|| CompareError::ResourceLimit("phase working set overflow".to_owned()))?;
        if working_bytes > options.max_working_bytes {
            return Err(CompareError::ResourceLimit(format!(
                "phase correlation needs {working_bytes} bytes; budget is {}",
                options.max_working_bytes
            )));
        }
        let mut fft = Fft2D::new(width, height)?;
        let mut values = Self::buffer(count)?;
        let mut left = Self::buffer(count)?;
        let mut right = Self::buffer(count)?;
        for channel in 0..4 {
            // Read the captured RGBA code values without another premultiplication or color
            // conversion. Summing channel cross-spectra retains isoluminant and alpha-only detail.
            reference_signal.fill(reference, channel, width, &mut left, options.taper_fraction);
            candidate_signal.fill(
                candidate,
                channel,
                width,
                &mut right,
                options.taper_fraction,
            );
            fft.transform(&mut left, false);
            fft.transform(&mut right, false);
            for ((sum, a), b) in values.iter_mut().zip(&left).zip(&right) {
                *sum += a * b.conj();
            }
        }
        values[0] = Complex::default();
        let largest = values
            .iter()
            .map(|value| value.norm())
            .fold(0.0_f64, f64::max);
        let floor = (largest * options.relative_spectral_floor).max(f64::EPSILON);
        let mut active_frequencies = 0;
        for value in &mut values {
            let magnitude = value.norm();
            // Phase-only normalization would give quantization-dominated bins the same weight as
            // informative bins. Apply a fixed, reported support floor before normalization.
            if magnitude > floor {
                *value /= magnitude;
                active_frequencies += 1;
            } else {
                *value = Complex::default();
            }
        }
        left.copy_from_slice(&values);
        fft.transform(&mut left, true);
        Ok(Self {
            width,
            height,
            values,
            correlation: left,
            active_frequencies,
            working_bytes,
        })
    }

    pub fn buffer(length: usize) -> Result<Vec<Complex<f64>>, CompareError> {
        let mut buffer = Vec::new();
        buffer.try_reserve_exact(length).map_err(|error| {
            CompareError::ResourceLimit(format!("phase buffer allocation failed: {error}"))
        })?;
        buffer.resize(length, Complex::default());
        Ok(buffer)
    }
}

pub(super) struct Fft2D {
    width: usize,
    height: usize,
    rows_forward: Arc<dyn Fft<f64>>,
    columns_forward: Arc<dyn Fft<f64>>,
    rows_inverse: Arc<dyn Fft<f64>>,
    columns_inverse: Arc<dyn Fft<f64>>,
    column: Vec<Complex<f64>>,
    scratch: Vec<Complex<f64>>,
}

impl Fft2D {
    pub fn new(width: usize, height: usize) -> Result<Self, CompareError> {
        let mut planner = FftPlanner::new();
        let rows_forward = planner.plan_fft_forward(width);
        let columns_forward = planner.plan_fft_forward(height);
        let rows_inverse = planner.plan_fft_inverse(width);
        let columns_inverse = planner.plan_fft_inverse(height);
        let scratch_length = [
            &rows_forward,
            &columns_forward,
            &rows_inverse,
            &columns_inverse,
        ]
        .iter()
        .map(|plan| plan.get_inplace_scratch_len())
        .fold(0, usize::max);
        Ok(Self {
            width,
            height,
            rows_forward,
            columns_forward,
            rows_inverse,
            columns_inverse,
            column: PhaseSpectrum::buffer(height)?,
            scratch: PhaseSpectrum::buffer(scratch_length)?,
        })
    }

    pub fn transform(&mut self, data: &mut [Complex<f64>], inverse: bool) {
        let (rows, columns) = if inverse {
            (&self.rows_inverse, &self.columns_inverse)
        } else {
            (&self.rows_forward, &self.columns_forward)
        };
        for row in data.chunks_exact_mut(self.width) {
            rows.process_with_scratch(row, &mut self.scratch);
        }
        for x in 0..self.width {
            for y in 0..self.height {
                self.column[y] = data[y * self.width + x];
            }
            columns.process_with_scratch(&mut self.column, &mut self.scratch);
            for y in 0..self.height {
                data[y * self.width + x] = self.column[y];
            }
        }
        if inverse {
            let normalization = (self.width * self.height) as f64;
            for value in data {
                *value /= normalization;
            }
        }
    }
}

use serde::Serialize;

use crate::{error::CompareError, image::RgbaImage};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SsimReport {
    pub channels: [f64; 4],
    // Profile SSIM averages RGB; alpha remains independently observable in channels[3].
    pub mean: f64,
    pub rgba_mean: f64,
    pub window_size: u32,
    pub sigma: f64,
    pub boundary: String,
}

struct SsimParameters {
    radius: usize,
    sigma: f64,
    data_range: f64,
    k1: f64,
    k2: f64,
}

impl Default for SsimParameters {
    fn default() -> Self {
        Self {
            radius: 5,
            sigma: 1.5,
            data_range: 255.0,
            k1: 0.01,
            k2: 0.03,
        }
    }
}

struct MomentRow {
    source_y: Option<usize>,
    values: Vec<[f64; 5]>,
}

pub struct Ssim;

impl Ssim {
    pub fn measure(
        reference: &RgbaImage,
        candidate: &RgbaImage,
    ) -> Result<SsimReport, CompareError> {
        reference.validate_pair(candidate)?;
        let parameters = SsimParameters::default();
        let mut report = SsimReport {
            channels: [1.0; 4],
            mean: 1.0,
            rgba_mean: 1.0,
            window_size: (parameters.radius * 2 + 1) as u32,
            sigma: parameters.sigma,
            boundary: "half_sample_symmetric_reflection".to_owned(),
        };
        if reference.pixels == candidate.pixels {
            return Ok(report);
        }
        let kernel: Vec<f64> = (0..report.window_size)
            .map(|index| {
                let distance = f64::from(index) - parameters.radius as f64;
                (-distance * distance / (2.0 * parameters.sigma * parameters.sigma)).exp()
            })
            .collect();
        let kernel_sum: f64 = kernel.iter().sum();
        let kernel: Vec<f64> = kernel.iter().map(|weight| weight / kernel_sum).collect();
        let width = reference.width as usize;
        let height = reference.height as usize;
        let mut rows = Vec::new();
        for _ in &kernel {
            let mut values = Vec::new();
            values.try_reserve_exact(width).map_err(|error| {
                CompareError::ResourceLimit(format!("SSIM row buffer: {error}"))
            })?;
            values.resize(width, [0.0; 5]);
            rows.push(MomentRow {
                source_y: None,
                values,
            });
        }
        let c1 = (parameters.k1 * parameters.data_range).powi(2);
        let c2 = (parameters.k2 * parameters.data_range).powi(2);
        for channel in 0..4 {
            for row in &mut rows {
                row.source_y = None;
            }
            let mut score_sum = 0.0;
            for y in 0..height {
                // The reflected neighborhood spans at most window_size distinct rows. Modulo
                // slots retain their horizontal moments as the vertical window advances.
                for offset in 0..kernel.len() {
                    let source_y =
                        Self::reflect(y as i64 + offset as i64 - parameters.radius as i64, height);
                    let row = &mut rows[source_y % kernel.len()];
                    if row.source_y != Some(source_y) {
                        Self::horizontal_moments(
                            row, source_y, channel, &kernel, reference, candidate,
                        );
                    }
                }
                for x in 0..width {
                    let mut moments = [0.0; 5];
                    for (offset, &weight) in kernel.iter().enumerate() {
                        let source_y = Self::reflect(
                            y as i64 + offset as i64 - parameters.radius as i64,
                            height,
                        );
                        for (moment, &sample) in moments
                            .iter_mut()
                            .zip(&rows[source_y % kernel.len()].values[x])
                        {
                            *moment += weight * sample;
                        }
                    }
                    let [
                        mean_reference,
                        mean_candidate,
                        square_reference,
                        square_candidate,
                        cross,
                    ] = moments;
                    // Population moments can yield tiny negative variances by cancellation.
                    let variance_reference =
                        (square_reference - mean_reference * mean_reference).max(0.0);
                    let variance_candidate =
                        (square_candidate - mean_candidate * mean_candidate).max(0.0);
                    let covariance = cross - mean_reference * mean_candidate;
                    let numerator =
                        (2.0 * mean_reference * mean_candidate + c1) * (2.0 * covariance + c2);
                    let denominator =
                        (mean_reference * mean_reference + mean_candidate * mean_candidate + c1)
                            * (variance_reference + variance_candidate + c2);
                    score_sum += (numerator / denominator).clamp(-1.0, 1.0);
                }
            }
            report.channels[channel] = score_sum / (width * height) as f64;
        }
        report.mean = report.channels[..3].iter().sum::<f64>() / 3.0;
        report.rgba_mean = report.channels.iter().sum::<f64>() / 4.0;
        if !report.channels.iter().all(|score| score.is_finite()) {
            return Err(CompareError::InvalidImage(
                "SSIM produced a non-finite result".to_owned(),
            ));
        }
        Ok(report)
    }

    fn reflect(index: i64, extent: usize) -> usize {
        let period = 2 * extent as i64;
        let index = index.rem_euclid(period);
        if index < extent as i64 {
            index as usize
        } else {
            (period - index - 1) as usize
        }
    }

    fn horizontal_moments(
        row: &mut MomentRow,
        source_y: usize,
        channel: usize,
        kernel: &[f64],
        reference: &RgbaImage,
        candidate: &RgbaImage,
    ) {
        let width = reference.width as usize;
        let radius = kernel.len() / 2;
        for (x, moments) in row.values.iter_mut().enumerate() {
            *moments = [0.0; 5];
            for (offset, &weight) in kernel.iter().enumerate() {
                let source_x = Self::reflect(x as i64 + offset as i64 - radius as i64, width);
                let index = (source_y * width + source_x) * 4 + channel;
                let reference = f64::from(reference.pixels[index]);
                let candidate = f64::from(candidate.pixels[index]);
                moments[0] += weight * reference;
                moments[1] += weight * candidate;
                moments[2] += weight * reference * reference;
                moments[3] += weight * candidate * candidate;
                moments[4] += weight * reference * candidate;
            }
        }
        row.source_y = Some(source_y);
    }
}

#[cfg(test)]
mod tests;

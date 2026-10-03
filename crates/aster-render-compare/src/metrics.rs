use serde::Serialize;

use crate::{error::CompareError, image::RgbaImage};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PsnrReport {
    Finite { db: f64 },
    Infinite,
}

impl PsnrReport {
    fn from_mean_squared_error(mean_squared_error: f64) -> Self {
        if mean_squared_error == 0.0 {
            Self::Infinite
        } else {
            Self::Finite {
                db: 10.0 * (255.0_f64.powi(2) / mean_squared_error).log10(),
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MetricsReport {
    pub exact: bool,
    pub pixel_count: u64,
    pub max_abs_channel_error: u8,
    pub mean_abs_error: f64,
    // RGBA MSE also defines temporal frame identity, including hidden color and alpha.
    pub mean_squared_error: f64,
    pub rgb_mean_squared_error: f64,
    // Profile PSNR uses RGB; matching alpha must not dilute a color mismatch.
    pub psnr: PsnrReport,
    pub rgba_psnr: PsnrReport,
    pub channel_tolerance: Option<u8>,
    pub pixels_above_tolerance: Option<u64>,
}

pub struct Metrics;

impl Metrics {
    pub fn measure(
        reference: &RgbaImage,
        candidate: &RgbaImage,
        channel_tolerance: Option<u8>,
    ) -> Result<MetricsReport, CompareError> {
        reference.validate_pair(candidate)?;
        let mut absolute_sum = 0_u128;
        let mut squared_sum = 0_u128;
        let mut rgb_squared_sum = 0_u128;
        let mut max_error = 0_u8;
        let mut above_tolerance = 0_u64;
        for (reference_pixel, candidate_pixel) in reference
            .pixels
            .chunks_exact(4)
            .zip(candidate.pixels.chunks_exact(4))
        {
            let mut pixel_error = 0_u8;
            for (channel, (&reference_channel, &candidate_channel)) in
                reference_pixel.iter().zip(candidate_pixel).enumerate()
            {
                let error = reference_channel.abs_diff(candidate_channel);
                absolute_sum += u128::from(error);
                squared_sum += u128::from(error) * u128::from(error);
                if channel < 3 {
                    rgb_squared_sum += u128::from(error) * u128::from(error);
                }
                pixel_error = pixel_error.max(error);
            }
            max_error = max_error.max(pixel_error);
            if channel_tolerance.is_some_and(|tolerance| pixel_error > tolerance) {
                above_tolerance += 1;
            }
        }
        let channel_count = reference.pixels.len() as f64;
        let mean_squared_error = squared_sum as f64 / channel_count;
        let rgb_mean_squared_error = rgb_squared_sum as f64 / (channel_count / 4.0 * 3.0);
        Ok(MetricsReport {
            exact: max_error == 0,
            pixel_count: u64::from(reference.width) * u64::from(reference.height),
            max_abs_channel_error: max_error,
            mean_abs_error: absolute_sum as f64 / channel_count,
            mean_squared_error,
            rgb_mean_squared_error,
            psnr: PsnrReport::from_mean_squared_error(rgb_mean_squared_error),
            rgba_psnr: PsnrReport::from_mean_squared_error(mean_squared_error),
            channel_tolerance,
            pixels_above_tolerance: channel_tolerance.map(|_| above_tolerance),
        })
    }
}

#[cfg(test)]
mod tests;

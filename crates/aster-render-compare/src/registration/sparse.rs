use serde::Serialize;

use super::{PhaseCorrelation, RegistrationOptions, RegistrationReport};
use crate::{error::CompareError, image::RgbaImage};

#[derive(Clone, Debug, Serialize)]
pub struct SparseSignal {
    pub background: [u8; 4],
    pub pixels: usize,
    pub fraction: f64,
    pub support_rms: f64,
}

impl SparseSignal {
    fn analyze(image: &RgbaImage, options: &RegistrationOptions) -> Option<Self> {
        let count = image.pixels.len() / 4;
        let mut sums = [0_u64; 4];
        for pixel in image.pixels.chunks_exact(4) {
            for (sum, value) in sums.iter_mut().zip(pixel) {
                *sum += u64::from(*value);
            }
        }
        // A background candidate is accepted only after an exhaustive occupancy check. It is
        // never subtracted from, masked out of, or otherwise substituted into the FFT inputs.
        let background = sums.map(|sum| ((sum + count as u64 / 2) / count as u64) as u8);
        let mut pixels = 0;
        let mut energy = 0.0;
        for pixel in image.pixels.chunks_exact(4) {
            if pixel == background {
                continue;
            }
            pixels += 1;
            for (value, base) in pixel.iter().zip(background) {
                energy += (f64::from(*value) - f64::from(base)).powi(2);
            }
        }
        let fraction = pixels as f64 / count as f64;
        if pixels < options.minimum_sparse_pixels || fraction > options.maximum_sparse_fraction {
            return None;
        }
        let support_rms = (energy / (4.0 * pixels as f64)).sqrt() / 255.0;
        (support_rms >= options.minimum_rms).then_some(Self {
            background,
            pixels,
            fraction,
            support_rms,
        })
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SparseRegistrationSupport {
    pub reference: SparseSignal,
    pub candidate: SparseSignal,
    pub maximum_fraction: f64,
    pub minimum_pixels: usize,
    pub minimum_support_rms: f64,
    pub minimum_coherence: f64,
}

impl PhaseCorrelation {
    pub(super) fn measure_sparse(
        reference: &RgbaImage,
        candidate: &RgbaImage,
        options: &RegistrationOptions,
    ) -> Result<Option<RegistrationReport>, CompareError> {
        let (Some(reference_support), Some(candidate_support)) = (
            SparseSignal::analyze(reference, options),
            SparseSignal::analyze(candidate, options),
        ) else {
            return Ok(None);
        };
        let sparse = RegistrationOptions {
            // Sparse local contrast has been established independently of the full-frame RMS.
            // Keep the original pixels, spectral floor, axis observability and peak checks.
            minimum_rms: f64::EPSILON,
            minimum_coherence: options
                .minimum_coherence
                .max(options.minimum_sparse_coherence),
            taper_fraction: options.taper_fraction * 0.5,
            ..options.clone()
        };
        let tapered = Self::measure_spectrum(reference, candidate, &sparse)?;
        let Some(tapered_shift) = tapered.shift else {
            return Ok(None);
        };
        let untapered = RegistrationOptions {
            taper_fraction: 0.0,
            ..sparse
        };
        let mut report = Self::measure_spectrum(reference, candidate, &untapered)?;
        let Some(shift) = report.shift else {
            return Ok(None);
        };
        let disagreement = (tapered_shift.dx - shift.dx).hypot(tapered_shift.dy - shift.dy);
        if disagreement > 2.0 / f64::from(options.upsample_factor) {
            return Ok(None);
        }
        report.quality.support_shift_disagreement = Some(disagreement);
        report.quality.sparse_support = Some(SparseRegistrationSupport {
            reference: reference_support,
            candidate: candidate_support,
            maximum_fraction: options.maximum_sparse_fraction,
            minimum_pixels: options.minimum_sparse_pixels,
            minimum_support_rms: options.minimum_rms,
            minimum_coherence: untapered.minimum_coherence,
        });
        report.diagnostic = Some(
            "sparse local contrast with high-coherence tapered and untapered phase agreement"
                .into(),
        );
        Ok(Some(report))
    }
}

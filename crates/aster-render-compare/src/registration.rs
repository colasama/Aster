//! Translation checks measure the original pixels; they never align comparison inputs.

mod refinement;
mod spectrum;
#[cfg(test)]
mod tests;

use serde::Serialize;

use crate::{error::CompareError, image::RgbaImage};
use refinement::CorrelationPeak;
use spectrum::{ImageSignal, PhaseSpectrum};

#[derive(Clone, Debug)]
pub struct RegistrationOptions {
    pub max_working_bytes: usize,
    pub upsample_factor: u32,
    pub taper_fraction: f64,
    pub relative_spectral_floor: f64,
    pub minimum_rms: f64,
    pub minimum_axis_ratio: f64,
    pub minimum_active_frequencies: usize,
    pub minimum_peak_ratio: f64,
    pub minimum_psr: f64,
    pub minimum_coherence: f64,
    pub minimum_window_energy_fraction: f64,
    pub peak_exclusion_radius: usize,
}

impl Default for RegistrationOptions {
    fn default() -> Self {
        Self {
            max_working_bytes: 1024 * 1024 * 1024,
            upsample_factor: 128,
            taper_fraction: 0.125,
            relative_spectral_floor: 0.001,
            minimum_rms: 1.0 / 255.0,
            minimum_axis_ratio: 0.000_1,
            minimum_active_frequencies: 32,
            minimum_peak_ratio: 1.1,
            minimum_psr: 8.0,
            minimum_coherence: 0.2,
            minimum_window_energy_fraction: 0.25,
            peak_exclusion_radius: 3,
        }
    }
}

impl RegistrationOptions {
    fn validate(&self) -> Result<(), CompareError> {
        if !(16..=1024).contains(&self.upsample_factor)
            || !self.upsample_factor.is_power_of_two()
            || !self.taper_fraction.is_finite()
            || !(0.0..=1.0).contains(&self.taper_fraction)
            || !self.relative_spectral_floor.is_finite()
            || !(0.0..1.0).contains(&self.relative_spectral_floor)
            || !self.minimum_rms.is_finite()
            || self.minimum_rms <= 0.0
            || !self.minimum_axis_ratio.is_finite()
            || !(0.0..0.5).contains(&self.minimum_axis_ratio)
            || self.minimum_axis_ratio == 0.0
            || self.minimum_active_frequencies == 0
            || !self.minimum_peak_ratio.is_finite()
            || self.minimum_peak_ratio <= 1.0
            || !self.minimum_psr.is_finite()
            || self.minimum_psr <= 0.0
            || !self.minimum_coherence.is_finite()
            || !(0.0..1.0).contains(&self.minimum_coherence)
            || self.minimum_coherence == 0.0
            || !self.minimum_window_energy_fraction.is_finite()
            || !(0.0..=1.0).contains(&self.minimum_window_energy_fraction)
            || self.minimum_window_energy_fraction == 0.0
            || self.peak_exclusion_radius == 0
        {
            return Err(CompareError::InvalidArgument(
                "invalid phase-correlation precision or quality configuration".to_owned(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RegistrationStatus {
    Measured,
    ExactIdentity,
    Indeterminate,
}

#[derive(Clone, Copy, Debug, Serialize)]
pub struct RegistrationShift {
    /// Translation to apply to the candidate to align it with the reference.
    pub dx: f64,
    pub dy: f64,
    pub distance: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct RegistrationQuality {
    pub reference_rms: f64,
    pub candidate_rms: f64,
    pub reference_axis_ratio: f64,
    pub candidate_axis_ratio: f64,
    pub reference_window_energy_fraction: f64,
    pub candidate_window_energy_fraction: f64,
    pub active_frequencies: usize,
    pub spectral_bins: usize,
    pub peak_ratio: Option<f64>,
    pub peak_to_sidelobe_ratio: Option<f64>,
    pub peak_coherence: Option<f64>,
    pub sampling_step_px: f64,
    pub relative_spectral_floor: f64,
    pub taper_fraction: f64,
    pub working_bytes: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct RegistrationReport {
    pub status: RegistrationStatus,
    pub shift: Option<RegistrationShift>,
    pub diagnostic: Option<String>,
    pub quality: RegistrationQuality,
}

impl RegistrationReport {
    fn indeterminate(diagnostic: impl Into<String>, quality: RegistrationQuality) -> Self {
        Self {
            status: RegistrationStatus::Indeterminate,
            shift: None,
            diagnostic: Some(diagnostic.into()),
            quality,
        }
    }
}

pub struct PhaseCorrelation;

impl PhaseCorrelation {
    pub fn measure(
        reference: &RgbaImage,
        candidate: &RgbaImage,
        options: &RegistrationOptions,
    ) -> Result<RegistrationReport, CompareError> {
        options.validate()?;
        Self::validate_images(reference, candidate)?;
        let quality = RegistrationQuality {
            sampling_step_px: 1.0 / f64::from(options.upsample_factor),
            relative_spectral_floor: options.relative_spectral_floor,
            taper_fraction: options.taper_fraction,
            ..RegistrationQuality::default()
        };
        if reference.pixels == candidate.pixels {
            return Ok(RegistrationReport {
                status: RegistrationStatus::ExactIdentity,
                shift: Some(RegistrationShift {
                    dx: 0.0,
                    dy: 0.0,
                    distance: 0.0,
                }),
                diagnostic: Some(
                    "coordinate-wise RGBA identity; no phase estimate required".to_owned(),
                ),
                quality,
            });
        }
        let reference_signal = ImageSignal::analyze(reference, options.taper_fraction);
        let candidate_signal = ImageSignal::analyze(candidate, options.taper_fraction);
        let mut quality = RegistrationQuality {
            reference_rms: reference_signal.rms,
            candidate_rms: candidate_signal.rms,
            reference_axis_ratio: reference_signal.axis_ratio,
            candidate_axis_ratio: candidate_signal.axis_ratio,
            reference_window_energy_fraction: reference_signal.window_energy_fraction,
            candidate_window_energy_fraction: candidate_signal.window_energy_fraction,
            ..quality
        };
        if reference_signal.rms < options.minimum_rms || candidate_signal.rms < options.minimum_rms
        {
            return Ok(RegistrationReport::indeterminate(
                "insufficient spatial signal",
                quality,
            ));
        }
        if reference_signal.axis_ratio < options.minimum_axis_ratio
            || candidate_signal.axis_ratio < options.minimum_axis_ratio
        {
            return Ok(RegistrationReport::indeterminate(
                "translation is not observable in both axes",
                quality,
            ));
        }
        if reference_signal.window_energy_fraction < options.minimum_window_energy_fraction
            || candidate_signal.window_energy_fraction < options.minimum_window_energy_fraction
        {
            return Ok(RegistrationReport::indeterminate(
                "boundary taper removes too much of the spatial signal",
                quality,
            ));
        }
        let spectrum = PhaseSpectrum::build(
            reference,
            candidate,
            &reference_signal,
            &candidate_signal,
            options,
        )?;
        quality.working_bytes = spectrum.working_bytes;
        quality.spectral_bins = spectrum.values.len();
        quality.active_frequencies = spectrum.active_frequencies;
        if spectrum.active_frequencies < options.minimum_active_frequencies {
            return Ok(RegistrationReport::indeterminate(
                "insufficient common spectral support",
                quality,
            ));
        }
        let peak = CorrelationPeak::locate(&spectrum, options);
        quality.peak_ratio = Some(peak.ratio);
        quality.peak_to_sidelobe_ratio = Some(peak.psr);
        quality.peak_coherence = Some(peak.coherence);
        if peak.ratio < options.minimum_peak_ratio
            || peak.psr < options.minimum_psr
            || peak.coherence < options.minimum_coherence
        {
            return Ok(RegistrationReport::indeterminate(
                "ambiguous or weak phase-correlation peak",
                quality,
            ));
        }
        let (dx, dy) = peak.refine(&spectrum, options)?;
        if dx.abs() >= f64::from(reference.width) || dy.abs() >= f64::from(reference.height) {
            return Ok(RegistrationReport::indeterminate(
                "phase peak is outside the overlapping image domain",
                quality,
            ));
        }
        Ok(RegistrationReport {
            status: RegistrationStatus::Measured,
            shift: Some(RegistrationShift {
                dx,
                dy,
                distance: dx.hypot(dy),
            }),
            diagnostic: None,
            quality,
        })
    }

    fn validate_images(reference: &RgbaImage, candidate: &RgbaImage) -> Result<(), CompareError> {
        for image in [reference, candidate] {
            let length = usize::try_from(image.width)
                .ok()
                .and_then(|width| {
                    usize::try_from(image.height)
                        .ok()
                        .and_then(|height| width.checked_mul(height))
                })
                .and_then(|pixels| pixels.checked_mul(4));
            if image.width == 0 || image.height == 0 || length != Some(image.pixels.len()) {
                return Err(CompareError::InvalidImage(
                    "registration requires complete, nonempty RGBA images".to_owned(),
                ));
            }
        }
        if reference.width != candidate.width || reference.height != candidate.height {
            return Err(CompareError::InvalidImage(
                "registration image dimensions differ".to_owned(),
            ));
        }
        Ok(())
    }
}

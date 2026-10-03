use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::{
    error::CompareError,
    image::RgbaImage,
    metrics::{Metrics, MetricsReport, PsnrReport},
    profile::SelectedProfile,
    registration::{PhaseCorrelation, RegistrationOptions, RegistrationReport, RegistrationStatus},
    sequence::{SequenceInput, SequenceReport},
    ssim::{Ssim, SsimReport},
    structural::{Structural, StructuralReport},
};

#[derive(Debug, Default)]
pub struct ComparisonOptions {
    pub isolated: bool,
    pub background: Option<[u8; 4]>,
    pub sequence: Option<SequenceInput>,
    pub registration: RegistrationOptions,
}

#[derive(Debug, Serialize)]
pub struct CheckResult {
    pub id: String,
    pub passed: bool,
}

#[derive(Debug, Serialize)]
pub struct ComparisonReport {
    pub schema_version: u32,
    pub passed: bool,
    pub self_review_required: bool,
    pub profile: SelectedProfile,
    pub width: u32,
    pub height: u32,
    pub reference_rgba_sha256: String,
    pub candidate_rgba_sha256: String,
    pub metrics: MetricsReport,
    pub ssim: SsimReport,
    pub structural: Option<StructuralReport>,
    pub registration: Option<RegistrationReport>,
    pub sequence: Option<SequenceReport>,
    pub isolated: bool,
    pub checks: Vec<CheckResult>,
}

pub struct Comparison;

impl Comparison {
    pub fn measure(
        reference: &RgbaImage,
        candidate: &RgbaImage,
        profile_name: &str,
        options: &ComparisonOptions,
    ) -> Result<ComparisonReport, CompareError> {
        if options.isolated != options.background.is_some() {
            return Err(CompareError::InvalidArgument(
                "An isolated case requires an explicit background; background is only valid for an isolated case".into(),
            ));
        }
        let profile = SelectedProfile::load(profile_name)?;
        let limits = &profile.limits;
        let tolerance = if limits.exact {
            Some(0)
        } else {
            limits.max_abs_channel_error
        };
        let metrics = Metrics::measure(reference, candidate, tolerance)?;
        let ssim = Ssim::measure(reference, candidate)?;
        let mut checks = Vec::new();
        if limits.exact {
            checks.push(CheckResult {
                id: "exact_rgba".into(),
                passed: metrics.exact,
            });
        }
        if let Some(limit) = limits.max_abs_channel_error {
            checks.push(CheckResult {
                id: "max_abs_channel_error".into(),
                passed: metrics.max_abs_channel_error <= limit,
            });
        }
        if let Some(limit) = limits.mean_abs_error {
            checks.push(CheckResult {
                id: "mean_abs_error".into(),
                passed: metrics.mean_abs_error <= limit,
            });
        }
        if let Some(limit) = limits.min_psnr_db {
            checks.push(CheckResult {
                id: "psnr".into(),
                passed: match metrics.psnr {
                    PsnrReport::Infinite => true,
                    PsnrReport::Finite { db } => db >= limit,
                },
            });
        }
        if let Some(limit) = limits.min_ssim {
            checks.push(CheckResult {
                id: "ssim".into(),
                passed: ssim.mean >= limit,
            });
        }
        let (structural, registration) = if let Some(limits) = &limits.structural {
            let structural = Structural::measure(reference, candidate, options.background)?;
            let registration =
                PhaseCorrelation::measure(reference, candidate, &options.registration)?;
            checks.extend([
                CheckResult {
                    id: "error_clusters".into(),
                    passed: structural.largest_error_component <= limits.largest_error_component,
                },
                CheckResult {
                    id: "signed_bias".into(),
                    passed: structural
                        .signed_bias
                        .iter()
                        .all(|bias| bias.abs() <= limits.max_abs_signed_bias),
                },
                CheckResult {
                    id: "alpha_coverage".into(),
                    passed: structural.alpha_changed_fraction <= limits.alpha_changed_fraction,
                },
                CheckResult {
                    id: "registration".into(),
                    passed: registration.status != RegistrationStatus::Indeterminate
                        && registration
                            .shift
                            .is_some_and(|shift| shift.distance <= limits.registration_distance),
                },
            ]);
            if let Some(ink) = &structural.ink_bounds {
                checks.push(CheckResult {
                    id: "ink_bounds".into(),
                    passed: ink.same_emptiness
                        && ink.edge_deltas.is_none_or(|deltas| {
                            deltas
                                .iter()
                                .all(|value| value.unsigned_abs() <= limits.ink_edge_delta)
                        }),
                });
            }
            (Some(structural), Some(registration))
        } else {
            (None, None)
        };
        let sequence = options
            .sequence
            .as_ref()
            .map(|input| input.measure(reference, candidate))
            .transpose()?;
        if let Some(sequence) = &sequence {
            checks.push(CheckResult {
                id: "frame_identity".into(),
                passed: sequence.passed,
            });
        }
        Ok(ComparisonReport {
            schema_version: 1,
            passed: checks.iter().all(|check| check.passed),
            self_review_required: !limits.exact,
            width: reference.width,
            height: reference.height,
            reference_rgba_sha256: format!("{:x}", Sha256::digest(&reference.pixels)),
            candidate_rgba_sha256: format!("{:x}", Sha256::digest(&candidate.pixels)),
            profile,
            metrics,
            ssim,
            structural,
            registration,
            sequence,
            isolated: options.isolated,
            checks,
        })
    }
}

#[cfg(test)]
mod tests;

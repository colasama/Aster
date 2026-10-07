use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{error::CompareError, profile::SelectedProfile};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResidualClass {
    FloatPrecision,
    DecoderRounding,
    SamplingOrder,
    ShapingHinting,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseLimit {
    profile: String,
    max_abs_channel_error: u8,
    residual_class: ResidualClass,
    reason: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CaseCatalog {
    schema_version: u32,
    cases: BTreeMap<String, CaseLimit>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AppliedCaseOverride {
    pub case_id: String,
    pub catalog_sha256: String,
    pub residual_class: ResidualClass,
    pub reason: String,
}

impl SelectedProfile {
    /// Only embedded, reviewed cases may increase the peak error; all structural limits remain.
    pub fn for_case(name: &str, case_id: Option<&str>) -> Result<Self, CompareError> {
        let mut profile = Self::load(name)?;
        if let Some(case_id) = case_id {
            profile.apply_case_catalog(
                case_id,
                include_bytes!("../../../tests/parity/tolerance-overrides.json"),
            )?;
        }
        Ok(profile)
    }

    fn apply_case_catalog(&mut self, case_id: &str, source: &[u8]) -> Result<(), CompareError> {
        let mut catalog: CaseCatalog = serde_json::from_slice(source)?;
        if catalog.schema_version != 1 {
            return Err(CompareError::InvalidArgument(
                "Unknown case tolerance schema".into(),
            ));
        }
        let Some(entry) = catalog.cases.remove(case_id) else {
            return Ok(());
        };
        if entry.profile != self.name {
            return Ok(());
        }
        if self.limits.exact
            || entry.max_abs_channel_error > 8
            || self
                .limits
                .max_abs_channel_error
                .is_none_or(|base| entry.max_abs_channel_error < base)
            || entry.reason.trim().is_empty()
        {
            return Err(CompareError::InvalidArgument(
                "Case tolerance exceeds its hard floor".into(),
            ));
        }
        self.limits.max_abs_channel_error = Some(entry.max_abs_channel_error);
        let perceptual = self.name == "perceptual";
        self.limits.min_psnr_db = Some(
            self.limits
                .min_psnr_db
                .map_or(0.0, |v| v)
                .max(if perceptual { 36.0 } else { 40.0 }),
        );
        self.limits.min_ssim = Some(self.limits.min_ssim.map_or(0.0, |v| v).max(if perceptual {
            0.99
        } else {
            0.995
        }));
        self.case_override = Some(AppliedCaseOverride {
            case_id: case_id.to_owned(),
            catalog_sha256: format!("{:x}", Sha256::digest(source)),
            residual_class: entry.residual_class,
            reason: entry.reason,
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn case_limits_cannot_relax_other_metrics_or_unrelated_cases() -> Result<(), CompareError> {
        let id = "native-generator-output-billboard-fxaa-beauty-motion";
        let approved = SelectedProfile::for_case("gpu", Some(id))?;
        assert_eq!(approved.limits.max_abs_channel_error, Some(7));
        assert_eq!(approved.limits.mean_abs_error, Some(0.05));
        assert_eq!(approved.limits.min_psnr_db, Some(50.0));
        assert_eq!(approved.limits.min_ssim, Some(0.995));
        let base = SelectedProfile::load("gpu")?;
        assert_eq!(
            serde_json::to_value(approved.limits.structural)?,
            serde_json::to_value(base.limits.structural)?
        );
        for case in [None, Some("unreviewed-case")] {
            assert_eq!(
                SelectedProfile::for_case("gpu", case)?
                    .limits
                    .max_abs_channel_error,
                Some(2)
            );
        }
        assert!(
            SelectedProfile::for_case("exact", Some(id))?
                .case_override
                .is_none()
        );
        let source = include_str!("../../../tests/parity/tolerance-overrides.json");
        for invalid in [
            source.replace(": 7,", ": 9,"),
            source.replace("float-precision", "structural"),
            source.replace("\"profile\": \"gpu\"", "\"profile\": \"exact\""),
        ] {
            let name = if invalid.contains("\"profile\": \"exact\"") {
                "exact"
            } else {
                "gpu"
            };
            assert!(
                SelectedProfile::load(name)?
                    .apply_case_catalog(id, invalid.as_bytes())
                    .is_err()
            );
        }
        Ok(())
    }
}

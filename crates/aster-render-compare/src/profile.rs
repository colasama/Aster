use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::CompareError;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StructuralLimits {
    pub largest_error_component: u64,
    pub max_abs_signed_bias: f64,
    pub alpha_changed_fraction: f64,
    pub registration_distance: f64,
    pub ink_edge_delta: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToleranceProfile {
    pub exact: bool,
    pub max_abs_channel_error: Option<u8>,
    pub mean_abs_error: Option<f64>,
    pub min_psnr_db: Option<f64>,
    pub min_ssim: Option<f64>,
    pub structural: Option<StructuralLimits>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProfileCatalog {
    schema_version: u32,
    profiles: BTreeMap<String, ToleranceProfile>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SelectedProfile {
    pub name: String,
    pub catalog_sha256: String,
    pub limits: ToleranceProfile,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub case_override: Option<crate::case_profile::AppliedCaseOverride>,
}

impl SelectedProfile {
    /// The checked-in catalog is embedded so a working-directory file cannot relax a gate.
    pub fn load(name: &str) -> Result<Self, CompareError> {
        let source = include_bytes!("../../../tests/parity/tolerances.json");
        let mut catalog: ProfileCatalog = serde_json::from_slice(source)?;
        if catalog.schema_version != 1 {
            return Err(CompareError::InvalidArgument(
                "Unknown tolerance schema".into(),
            ));
        }
        let limits = catalog.profiles.remove(name).ok_or_else(|| {
            CompareError::InvalidArgument(format!("Unknown tolerance profile: {name}"))
        })?;
        if (name == "exact") != limits.exact
            || (limits.exact
                && (limits.structural.is_some()
                    || limits.max_abs_channel_error.is_some()
                    || limits.mean_abs_error.is_some()
                    || limits.min_psnr_db.is_some()
                    || limits.min_ssim.is_some()))
            || (!limits.exact && (limits.structural.is_none() || limits.min_psnr_db.is_none()))
        {
            return Err(CompareError::InvalidArgument(
                "Invalid tolerance profile".into(),
            ));
        }
        Ok(Self {
            name: name.to_owned(),
            catalog_sha256: format!("{:x}", Sha256::digest(source)),
            limits,
            case_override: None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_required_defaults() -> Result<(), CompareError> {
        let gpu = SelectedProfile::load("gpu")?;
        assert_eq!(gpu.limits.max_abs_channel_error, Some(2));
        assert_eq!(gpu.limits.mean_abs_error, Some(0.05));
        assert_eq!(gpu.limits.min_psnr_db, Some(50.0));
        let decode = SelectedProfile::load("decode")?;
        assert_eq!(decode.limits.max_abs_channel_error, Some(4));
        assert_eq!(decode.limits.mean_abs_error, Some(0.5));
        assert_eq!(decode.limits.min_psnr_db, Some(42.0));
        let yuv = SelectedProfile::load("yuv")?;
        assert_eq!(yuv.limits.min_psnr_db, Some(40.0));
        assert!(yuv.limits.max_abs_channel_error.is_none());
        let perceptual = SelectedProfile::load("perceptual")?;
        assert_eq!(perceptual.limits.min_psnr_db, Some(38.0));
        assert_eq!(perceptual.limits.min_ssim, Some(0.99));
        for name in ["gpu", "decode", "yuv", "perceptual"] {
            let profile = SelectedProfile::load(name)?;
            let limits = profile
                .limits
                .structural
                .ok_or_else(|| CompareError::InvalidArgument(name.into()))?;
            let perceptual = name == "perceptual";
            assert_eq!(
                limits.largest_error_component,
                if perceptual { 256 } else { 64 }
            );
            assert_eq!(
                limits.max_abs_signed_bias,
                if perceptual { 1.0 } else { 0.5 }
            );
            assert_eq!(
                limits.alpha_changed_fraction,
                if perceptual { 0.005 } else { 0.001 }
            );
            assert_eq!(
                limits.registration_distance,
                if perceptual { 0.5 } else { 0.25 }
            );
            assert_eq!(limits.ink_edge_delta, 1);
        }
        assert!(SelectedProfile::load("exact")?.limits.exact);
        assert!(SelectedProfile::load("unreviewed").is_err());
        Ok(())
    }
}

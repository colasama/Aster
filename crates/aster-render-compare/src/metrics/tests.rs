use super::{Metrics, PsnrReport};
use crate::{error::CompareError, image::RgbaImage};

#[test]
fn preserves_hidden_rgb_and_counts_pixels_instead_of_channels() -> Result<(), CompareError> {
    let reference = RgbaImage {
        width: 2,
        height: 1,
        pixels: vec![0, 0, 0, 0, 255, 255, 255, 255],
    };
    let candidate = RgbaImage {
        width: 2,
        height: 1,
        pixels: vec![3, 4, 0, 0, 253, 255, 255, 255],
    };
    let result = Metrics::measure(&reference, &candidate, Some(2))?;
    assert!(!result.exact);
    assert_eq!(result.pixel_count, 2);
    assert_eq!(result.max_abs_channel_error, 4);
    assert_eq!(result.mean_abs_error, 9.0 / 8.0);
    assert_eq!(result.mean_squared_error, 29.0 / 8.0);
    assert_eq!(result.rgb_mean_squared_error, 29.0 / 6.0);
    assert_eq!(result.pixels_above_tolerance, Some(1));
    let PsnrReport::Finite { db } = result.psnr else {
        return Err(CompareError::InvalidArgument("Expected finite PSNR".into()));
    };
    assert!((db - 10.0 * (65025.0_f64 / (29.0 / 6.0)).log10()).abs() < 1e-12);
    let PsnrReport::Finite { db: rgba_db } = result.rgba_psnr else {
        return Err(CompareError::InvalidArgument(
            "Expected finite RGBA PSNR".into(),
        ));
    };
    assert!((rgba_db - 10.0 * (65025.0_f64 / (29.0 / 8.0)).log10()).abs() < 1e-12);
    assert_eq!(
        Metrics::measure(&reference, &candidate, Some(0))?.pixels_above_tolerance,
        Some(2)
    );
    Ok(())
}

#[test]
fn exact_psnr_has_a_serializable_infinite_state() -> Result<(), CompareError> {
    let image = RgbaImage {
        width: 1,
        height: 1,
        pixels: vec![217, 11, 99, 0],
    };
    let result = Metrics::measure(&image, &image, None)?;
    assert!(result.exact);
    assert_eq!(result.mean_squared_error, 0.0);
    assert_eq!(result.rgb_mean_squared_error, 0.0);
    assert_eq!(result.psnr, PsnrReport::Infinite);
    assert_eq!(result.rgba_psnr, PsnrReport::Infinite);
    assert_eq!(result.pixels_above_tolerance, None);
    let encoded = serde_json::to_value(&result)?;
    assert_eq!(encoded["psnr"]["kind"], "infinite");
    assert_eq!(encoded["rgba_psnr"]["kind"], "infinite");
    assert!(encoded["pixels_above_tolerance"].is_null());
    Ok(())
}

#[test]
fn alpha_only_error_keeps_rgba_statistics_and_is_not_exact() -> Result<(), CompareError> {
    let reference = RgbaImage::new(1, 1, vec![19, 47, 211, 255])?;
    let candidate = RgbaImage::new(1, 1, vec![19, 47, 211, 0])?;
    let result = Metrics::measure(&reference, &candidate, Some(2))?;
    assert!(!result.exact);
    assert_eq!(result.psnr, PsnrReport::Infinite);
    assert_eq!(result.rgb_mean_squared_error, 0.0);
    assert_eq!(result.mean_squared_error, 65025.0 / 4.0);
    assert!(matches!(result.rgba_psnr, PsnrReport::Finite { db }
        if (db - 10.0 * 4.0_f64.log10()).abs() < 1e-12));
    assert_eq!(result.max_abs_channel_error, 255);
    assert_eq!(result.mean_abs_error, 255.0 / 4.0);
    assert_eq!(result.pixels_above_tolerance, Some(1));
    Ok(())
}

#[test]
fn full_range_error_produces_zero_db_and_no_integer_wrap() -> Result<(), CompareError> {
    let reference = RgbaImage {
        width: 32,
        height: 17,
        pixels: vec![0; 32 * 17 * 4],
    };
    let candidate = RgbaImage {
        width: 32,
        height: 17,
        pixels: vec![255; 32 * 17 * 4],
    };
    let result = Metrics::measure(&reference, &candidate, Some(255))?;
    assert_eq!(result.max_abs_channel_error, 255);
    assert_eq!(result.mean_abs_error, 255.0);
    assert_eq!(result.mean_squared_error, 65025.0);
    assert_eq!(result.psnr, PsnrReport::Finite { db: 0.0 });
    assert_eq!(result.pixels_above_tolerance, Some(0));
    Ok(())
}

#[test]
fn rejects_incompatible_or_malformed_images() {
    let reference = RgbaImage {
        width: 1,
        height: 1,
        pixels: vec![0; 4],
    };
    for candidate in [
        RgbaImage {
            width: 2,
            height: 1,
            pixels: vec![0; 8],
        },
        RgbaImage {
            width: 1,
            height: 1,
            pixels: vec![0; 3],
        },
    ] {
        assert!(Metrics::measure(&reference, &candidate, None).is_err());
    }
}

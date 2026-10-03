use super::*;

#[test]
fn exact_compares_hidden_rgb_and_nonexact_never_skips_structure() -> Result<(), CompareError> {
    let reference = RgbaImage::new(1, 1, vec![0, 0, 0, 0])?;
    let candidate = RgbaImage::new(1, 1, vec![1, 0, 0, 0])?;
    let exact = Comparison::measure(
        &reference,
        &candidate,
        "exact",
        &ComparisonOptions::default(),
    )?;
    assert!(!exact.passed);
    assert!(!exact.self_review_required);
    let gpu = Comparison::measure(&reference, &reference, "gpu", &ComparisonOptions::default())?;
    assert!(gpu.passed);
    assert!(gpu.self_review_required);
    assert!(gpu.structural.is_some());
    assert!(gpu.registration.is_some());
    Ok(())
}

#[test]
fn numeric_success_cannot_hide_indeterminate_registration() -> Result<(), CompareError> {
    let reference = RgbaImage::new(32, 32, vec![128; 32 * 32 * 4])?;
    let mut candidate = reference.clone();
    candidate.pixels[0] += 1;
    let report = Comparison::measure(&reference, &candidate, "gpu", &ComparisonOptions::default())?;
    assert!(!report.passed);
    assert!(
        report
            .checks
            .iter()
            .filter(|check| check.id != "registration")
            .all(|check| check.passed)
    );
    assert_eq!(
        report.registration.map(|report| report.status),
        Some(RegistrationStatus::Indeterminate)
    );
    Ok(())
}

#[test]
fn isolated_cases_require_explicit_background() -> Result<(), CompareError> {
    let image = RgbaImage::new(1, 1, vec![0; 4])?;
    let mut options = ComparisonOptions {
        isolated: true,
        ..ComparisonOptions::default()
    };
    assert!(Comparison::measure(&image, &image, "gpu", &options).is_err());
    options.background = Some([0; 4]);
    let report = Comparison::measure(&image, &image, "gpu", &options)?;
    assert!(report.passed);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.id == "ink_bounds" && check.passed)
    );
    Ok(())
}

#[test]
fn sequence_is_checked_even_when_current_pixels_are_identical() -> Result<(), CompareError> {
    let image = RgbaImage::new(1, 1, vec![0; 4])?;
    let options = ComparisonOptions {
        sequence: Some(SequenceInput {
            frame: 0,
            first_frame: 0,
            last_frame: 1,
            previous: None,
            next: Some(image.clone()),
        }),
        ..ComparisonOptions::default()
    };
    let report = Comparison::measure(&image, &image, "gpu", &options)?;
    assert!(!report.passed);
    assert!(report.metrics.exact);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.id == "frame_identity" && !check.passed)
    );
    Ok(())
}

#[test]
fn matching_opaque_alpha_cannot_raise_rgb_psnr_past_yuv_threshold() -> Result<(), CompareError> {
    let reference = RgbaImage::new(8, 1, [128, 128, 128, 255].repeat(8))?;
    let mut candidate = reference.clone();
    for (index, pixel) in candidate.pixels.chunks_exact_mut(4).enumerate() {
        pixel[..3].fill(if index == 0 { 130 } else { 131 });
    }
    let report = Comparison::measure(&reference, &candidate, "yuv", &ComparisonOptions::default())?;
    // Seven errors of 3 and one of 2 per color channel give exactly 67/8 RGB MSE.
    let expected_rgb_mse = 67.0 / 8.0;
    let expected_rgb_psnr = 10.0 * (65025.0_f64 / expected_rgb_mse).log10();
    let expected_rgba_psnr = 10.0 * (65025.0_f64 / (expected_rgb_mse * 0.75)).log10();
    assert!((38.89..38.91).contains(&expected_rgb_psnr));
    assert!(expected_rgba_psnr > 40.0);
    assert_eq!(report.metrics.rgb_mean_squared_error, expected_rgb_mse);
    assert_eq!(report.metrics.mean_squared_error, expected_rgb_mse * 0.75);
    assert!(matches!(report.metrics.psnr, PsnrReport::Finite { db }
        if (db - expected_rgb_psnr).abs() < 1e-12));
    assert!(matches!(report.metrics.rgba_psnr, PsnrReport::Finite { db }
        if (db - expected_rgba_psnr).abs() < 1e-12));
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.id == "psnr" && !check.passed)
    );
    assert!(!report.passed);
    Ok(())
}

#[test]
fn matching_opaque_alpha_cannot_raise_rgb_ssim_past_perceptual_threshold()
-> Result<(), CompareError> {
    let reference = RgbaImage::new(1, 1, vec![18, 18, 18, 255])?;
    let candidate = RgbaImage::new(1, 1, vec![21, 21, 21, 255])?;
    let report = Comparison::measure(
        &reference,
        &candidate,
        "perceptual",
        &ComparisonOptions::default(),
    )?;
    // Constant fields have zero population variance: SSIM reduces to this luminance ratio.
    let expected_rgb_ssim = (2.0 * 18.0 * 21.0 + 6.5025) / (18.0 * 18.0 + 21.0 * 21.0 + 6.5025);
    let expected_rgba_ssim = (3.0 * expected_rgb_ssim + 1.0) / 4.0;
    assert!((0.988..0.989).contains(&expected_rgb_ssim));
    assert!(expected_rgba_ssim > 0.99);
    assert!((report.ssim.mean - expected_rgb_ssim).abs() < 1e-12);
    assert!((report.ssim.rgba_mean - expected_rgba_ssim).abs() < 1e-12);
    assert!((report.ssim.channels[3] - 1.0).abs() < 1e-12);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.id == "ssim" && !check.passed)
    );
    assert!(!report.passed);
    Ok(())
}

use super::{PhaseCorrelation, RegistrationOptions, RegistrationStatus};
use crate::{error::CompareError, image::RgbaImage};
use rustfft::num_complex::Complex;

struct AnalyticImage;

impl AnalyticImage {
    fn sparse(dx: f64, dy: f64) -> RgbaImage {
        let (width, height) = (512, 512);
        let mut pixels = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let mut signal = 0.0;
                for (cx, cy, amplitude, radius) in [
                    (173.3, 209.7, 22.0, 1.6),
                    (329.1, 427.2, -18.0, 2.1),
                    (413.8, 341.1, 25.0, 1.4),
                ] {
                    signal += amplitude
                        * (-((x as f64 - dx - cx).powi(2) + (y as f64 - dy - cy).powi(2))
                            / (2.0 * radius * radius))
                            .exp();
                }
                pixels.extend([(67.0 + signal).round() as u8, 221, 179, 255]);
            }
        }
        RgbaImage {
            width: width as u32,
            height: height as u32,
            pixels,
        }
    }

    fn near_edge(dx: f64) -> RgbaImage {
        let (width, height) = (256, 128);
        let mut pixels = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let signal = (-((x as f64 - 4.0 - dx).powi(2) / 8.0
                    + (y as f64 - 53.7).powi(2) / 98.0))
                    .exp();
                let value = (64.0 + 160.0 * signal).round() as u8;
                pixels.extend([value, value, value, 255]);
            }
        }
        RgbaImage {
            width: width as u32,
            height: height as u32,
            pixels,
        }
    }

    fn shifted(dx: f64, dy: f64, channel: &str) -> RgbaImage {
        let (width, height) = if channel == "odd" {
            (127, 95)
        } else {
            (128, 96)
        };
        let mut pixels = Vec::with_capacity(width * height * 4);
        for y in 0..height {
            for x in 0..width {
                let (px, py) = (x as f64 - dx, y as f64 - dy);
                // Independent continuous-space samples, not resampling or the FFT under test.
                let mut signal = 0.0;
                for (cx, cy, radius, amplitude) in [
                    (29.3, 23.7, 2.3, 0.32),
                    (77.8, 34.2, 3.1, -0.29),
                    (41.1, 62.8, 2.6, -0.25),
                    (89.4, 71.3, 1.9, 0.34),
                    (60.7, 45.4, 3.5, 0.19),
                ] {
                    let radius = if channel == "smooth" {
                        radius * 2.1
                    } else {
                        radius
                    };
                    signal += amplitude
                        * (-((px - cx).powi(2) + (py - cy).powi(2)) / (2.0 * radius * radius))
                            .exp();
                }
                if channel == "low_contrast" {
                    signal *= 0.1;
                }
                let value = (128.0 + 255.0 * signal).round().clamp(0.0, 255.0) as u8;
                let pixel = match channel {
                    "alpha" => [255, 255, 255, value],
                    "chroma" => [
                        value,
                        (128.0 - 255.0 * signal * 0.2126 / 0.7152)
                            .round()
                            .clamp(0.0, 255.0) as u8,
                        128,
                        255,
                    ],
                    _ => [value, value, value, 255],
                };
                pixels.extend(pixel);
            }
        }
        RgbaImage {
            width: width as u32,
            height: height as u32,
            pixels,
        }
    }

    fn pattern(kind: &str, shift: usize) -> RgbaImage {
        let mut pixels = Vec::new();
        for y in 0..64 {
            for x in 0..64 {
                let value = match kind {
                    "solid" => 127 + shift as u8,
                    "transparent" => 64 + shift as u8,
                    "stripe" => {
                        if (x + shift) % 16 < 8 {
                            64
                        } else {
                            192
                        }
                    }
                    _ => {
                        if ((x + shift) / 8 + y / 8).is_multiple_of(2) {
                            64
                        } else {
                            192
                        }
                    }
                };
                pixels.extend([
                    value,
                    value,
                    value,
                    if kind == "transparent" { 0 } else { 255 },
                ]);
            }
        }
        RgbaImage {
            width: 64,
            height: 64,
            pixels,
        }
    }
}

#[test]
fn sparse_local_contrast_recovers_real_measurements_on_both_sides_of_the_limit()
-> Result<(), CompareError> {
    let reference = AnalyticImage::sparse(0.0, 0.0);
    for (dx, dy, accepted) in [
        (0.0, 0.0, true),
        (0.24, 0.0, true),
        (0.26, 0.0, false),
        (-0.26, 0.0, false),
        (1.0, 0.0, false),
        (0.18, 0.18, false),
    ] {
        let mut candidate = AnalyticImage::sparse(dx, dy);
        candidate.pixels[(210 * 512 + 173) * 4] += 1;
        let report =
            PhaseCorrelation::measure(&reference, &candidate, &RegistrationOptions::default())?;
        assert_eq!(report.status, RegistrationStatus::Measured, "{report:?}");
        assert!(report.quality.sparse_support.is_some(), "{report:?}");
        assert_eq!(
            report.shift.is_some_and(|shift| shift.distance <= 0.25),
            accepted,
            "({dx},{dy}): {report:?}"
        );
    }
    Ok(())
}

#[test]
fn sparse_recovery_cannot_invent_signal_in_a_uniform_reference() -> Result<(), CompareError> {
    let mut reference = AnalyticImage::sparse(0.0, 0.0);
    for pixel in reference.pixels.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[67, 221, 179, 255]);
    }
    let candidate = AnalyticImage::sparse(0.0, 0.0);
    let report =
        PhaseCorrelation::measure(&reference, &candidate, &RegistrationOptions::default())?;
    assert_eq!(report.status, RegistrationStatus::Indeterminate);
    assert!(report.shift.is_none());
    assert!(report.quality.sparse_support.is_none());
    Ok(())
}

#[test]
fn near_edge_signal_is_recovered_without_accepting_a_real_subpixel_shift()
-> Result<(), CompareError> {
    let reference = AnalyticImage::near_edge(0.0);
    for dx in [0.0, 0.26, -0.26, 1.0] {
        let mut candidate = AnalyticImage::near_edge(dx);
        candidate.pixels[(54 * 256 + 4) * 4] += 1;
        let report =
            PhaseCorrelation::measure(&reference, &candidate, &RegistrationOptions::default())?;
        if dx == 0.0 {
            assert_eq!(report.status, RegistrationStatus::Measured, "{report:?}");
            assert!(report.shift.is_some_and(|shift| shift.distance < 0.02));
        } else {
            assert!(
                report.status == RegistrationStatus::Indeterminate
                    || report.shift.is_some_and(|shift| shift.distance > 0.25),
                "shift {dx}: {report:?}"
            );
        }
    }
    Ok(())
}

#[test]
fn analytic_rgba8_subpixel_shifts_straddle_both_tolerance_limits() -> Result<(), CompareError> {
    let options = RegistrationOptions::default();
    let mut failures = Vec::new();
    for channel in ["rgb", "alpha", "chroma", "odd", "smooth"] {
        let reference = AnalyticImage::shifted(0.0, 0.0, channel);
        for (dx, dy, limit, expected_pass) in [
            (0.24, 0.0, 0.25, true),
            (0.26, 0.0, 0.25, false),
            (-0.24, 0.0, 0.25, true),
            (-0.26, 0.0, 0.25, false),
            (0.0, 0.49, 0.5, true),
            (0.0, 0.51, 0.5, false),
            (0.0, -0.49, 0.5, true),
            (0.0, -0.51, 0.5, false),
            (0.18, 0.18, 0.25, false),
        ] {
            let candidate = AnalyticImage::shifted(dx, dy, channel);
            let report = PhaseCorrelation::measure(&reference, &candidate, &options)?;
            let valid = report.shift.is_some_and(|shift| {
                (shift.dx + dx).abs() < 0.02
                    && (shift.dy + dy).abs() < 0.02
                    && (shift.distance <= limit) == expected_pass
            });
            if report.status != RegistrationStatus::Measured || !valid {
                failures.push(format!("{channel}, ({dx},{dy}): {report:?}"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    Ok(())
}

#[test]
fn two_dimensional_rustfft_layout_and_inverse_match_independent_direct_dft()
-> Result<(), CompareError> {
    let (width, height) = (8, 4);
    let original: Vec<_> = (0..width * height)
        .map(|index| {
            Complex::new(
                (index * 7 % 19) as f64 / 19.0,
                (index * 3 % 11) as f64 / 11.0,
            )
        })
        .collect();
    let mut actual = original.clone();
    let mut fft = super::spectrum::Fft2D::new(width, height)?;
    fft.transform(&mut actual, false);
    for ky in 0..height {
        for kx in 0..width {
            let mut expected = Complex::default();
            for y in 0..height {
                for x in 0..width {
                    let angle = -std::f64::consts::TAU
                        * ((kx * x) as f64 / width as f64 + (ky * y) as f64 / height as f64);
                    expected += original[y * width + x] * Complex::from_polar(1.0, angle);
                }
            }
            assert!((actual[ky * width + kx] - expected).norm() < 1e-10);
        }
    }
    fft.transform(&mut actual, true);
    for (actual, expected) in actual.iter().zip(original) {
        assert!((*actual - expected).norm() < 1e-10);
    }
    Ok(())
}

#[test]
fn local_upsampled_dft_resolves_an_independent_analytic_phase_ramp() -> Result<(), CompareError> {
    let (width, height, dx, dy) = (16, 32, 2.24, -3.51);
    let mut values = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let fx = if x < width / 2 {
                x as f64
            } else {
                x as f64 - width as f64
            };
            let fy = if y < height / 2 {
                y as f64
            } else {
                y as f64 - height as f64
            };
            let phase = -std::f64::consts::TAU * (fx * dx / width as f64 + fy * dy / height as f64);
            values.push(Complex::from_polar(1.0, phase));
        }
    }
    let mut correlation = values.clone();
    super::spectrum::Fft2D::new(width, height)?.transform(&mut correlation, true);
    let spectrum = super::spectrum::PhaseSpectrum {
        width,
        height,
        values,
        correlation,
        active_frequencies: width * height,
        working_bytes: 0,
    };
    let options = RegistrationOptions::default();
    let (actual_x, actual_y) = super::refinement::CorrelationPeak::locate(&spectrum, &options)
        .refine(&spectrum, &options)?;
    assert!((actual_x - dx).abs() <= 0.5 / f64::from(options.upsample_factor));
    assert!((actual_y - dy).abs() <= 0.5 / f64::from(options.upsample_factor));
    Ok(())
}

#[test]
fn a_boundary_window_cannot_erase_the_only_feature_and_report_zero_translation()
-> Result<(), CompareError> {
    let mut images = [
        AnalyticImage::pattern("solid", 0),
        AnalyticImage::pattern("solid", 0),
    ];
    for (shift, image) in images.iter_mut().enumerate() {
        for y in 16..48 {
            image.pixels[(y * 64 + shift) * 4..][..3].fill(255);
        }
    }
    let report =
        PhaseCorrelation::measure(&images[0], &images[1], &RegistrationOptions::default())?;
    assert_eq!(
        report.status,
        RegistrationStatus::Indeterminate,
        "{report:?}"
    );
    assert!(report.shift.is_none());
    Ok(())
}

#[test]
fn insufficient_contrast_and_unrelated_noise_do_not_produce_trusted_shifts()
-> Result<(), CompareError> {
    let options = RegistrationOptions::default();
    let report = PhaseCorrelation::measure(
        &AnalyticImage::shifted(0.0, 0.0, "low_contrast"),
        &AnalyticImage::shifted(0.26, 0.0, "low_contrast"),
        &options,
    )?;
    assert_eq!(
        report.status,
        RegistrationStatus::Indeterminate,
        "{report:?}"
    );
    let mut images = [
        AnalyticImage::pattern("solid", 0),
        AnalyticImage::pattern("solid", 0),
    ];
    for (seed, image) in images.iter_mut().enumerate() {
        let mut state = 1 + seed as u64;
        for pixel in image.pixels.chunks_exact_mut(4) {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1);
            pixel[..3].fill((state >> 32) as u8);
        }
    }
    let report = PhaseCorrelation::measure(&images[0], &images[1], &options)?;
    assert_eq!(
        report.status,
        RegistrationStatus::Indeterminate,
        "{report:?}"
    );
    Ok(())
}

#[test]
fn integer_shifts_preserve_axes_signs_and_are_not_limited_to_the_tolerance_window()
-> Result<(), CompareError> {
    let reference = AnalyticImage::shifted(0.0, 0.0, "rgb");
    let candidate = AnalyticImage::shifted(4.0, -3.0, "rgb");
    let report =
        PhaseCorrelation::measure(&reference, &candidate, &RegistrationOptions::default())?;
    assert_eq!(report.status, RegistrationStatus::Measured, "{report:?}");
    let Some(shift) = report.shift else {
        panic!("measured report lacks a shift")
    };
    assert!(
        (shift.dx + 4.0).abs() < 0.02 && (shift.dy - 3.0).abs() < 0.02,
        "{report:?}"
    );
    Ok(())
}

#[test]
fn exact_identity_is_distinguished_from_an_unobservable_estimate() -> Result<(), CompareError> {
    for kind in ["solid", "transparent", "stripe", "checker"] {
        let image = AnalyticImage::pattern(kind, 0);
        let report = PhaseCorrelation::measure(&image, &image, &RegistrationOptions::default())?;
        assert_eq!(report.status, RegistrationStatus::ExactIdentity);
        assert!(report.diagnostic.is_some());
        assert_eq!(report.quality.working_bytes, 0);
    }
    Ok(())
}

#[test]
fn nonidentical_textureless_and_single_axis_inputs_cannot_pass_registration()
-> Result<(), CompareError> {
    for kind in ["solid", "transparent", "stripe"] {
        let report = PhaseCorrelation::measure(
            &AnalyticImage::pattern(kind, 0),
            &AnalyticImage::pattern(kind, 1),
            &RegistrationOptions::default(),
        )?;
        assert_eq!(
            report.status,
            RegistrationStatus::Indeterminate,
            "{kind}: {report:?}"
        );
        assert!(report.shift.is_none());
    }
    Ok(())
}

#[test]
fn periodic_multipeak_patterns_are_not_resolved_by_choosing_the_nearest_origin()
-> Result<(), CompareError> {
    let report = PhaseCorrelation::measure(
        &AnalyticImage::pattern("checker", 0),
        &AnalyticImage::pattern("checker", 4),
        &RegistrationOptions::default(),
    )?;
    assert_eq!(
        report.status,
        RegistrationStatus::Indeterminate,
        "{report:?}"
    );
    Ok(())
}

#[test]
fn malformed_inputs_configuration_and_insufficient_memory_are_errors() -> Result<(), CompareError> {
    let reference = AnalyticImage::shifted(0.0, 0.0, "rgb");
    let candidate = AnalyticImage::shifted(0.26, 0.0, "rgb");
    let options = RegistrationOptions {
        max_working_bytes: 1,
        ..RegistrationOptions::default()
    };
    assert!(matches!(
        PhaseCorrelation::measure(&reference, &candidate, &options),
        Err(CompareError::ResourceLimit(_))
    ));
    let options = RegistrationOptions {
        relative_spectral_floor: f64::NAN,
        ..RegistrationOptions::default()
    };
    assert!(matches!(
        PhaseCorrelation::measure(&reference, &candidate, &options),
        Err(CompareError::InvalidArgument(_))
    ));
    let mut truncated = AnalyticImage::shifted(0.0, 0.0, "rgb");
    truncated.pixels.pop();
    assert!(matches!(
        PhaseCorrelation::measure(&reference, &truncated, &RegistrationOptions::default()),
        Err(CompareError::InvalidImage(_))
    ));
    Ok(())
}

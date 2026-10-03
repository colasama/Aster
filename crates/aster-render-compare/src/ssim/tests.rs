use super::Ssim;
use crate::{error::CompareError, image::RgbaImage};

struct DirectSsim;

impl DirectSsim {
    fn sample(image: &RgbaImage, mut x: i64, mut y: i64, channel: usize) -> f64 {
        let width = i64::from(image.width);
        let height = i64::from(image.height);
        while x < 0 || x >= width {
            x = if x < 0 { -1 - x } else { 2 * width - 1 - x };
        }
        while y < 0 || y >= height {
            y = if y < 0 { -1 - y } else { 2 * height - 1 - y };
        }
        f64::from(image.pixels[(y as usize * width as usize + x as usize) * 4 + channel])
    }

    // Independent, direct 2D oracle: compute centered population moments from all 121 samples.
    // This deliberately does not use the separable implementation or its modular reflection.
    fn measure(reference: &RgbaImage, candidate: &RgbaImage) -> [f64; 4] {
        let mut scores = [0.0; 4];
        for (channel, score) in scores.iter_mut().enumerate() {
            for y in 0..i64::from(reference.height) {
                for x in 0..i64::from(reference.width) {
                    let mut samples = Vec::new();
                    let mut weight_sum = 0.0;
                    let mut means = [0.0; 2];
                    for dy in -5_i64..=5 {
                        for dx in -5_i64..=5 {
                            let weight = (-(dx * dx + dy * dy) as f64 / 4.5).exp();
                            let reference = Self::sample(reference, x + dx, y + dy, channel);
                            let candidate = Self::sample(candidate, x + dx, y + dy, channel);
                            samples.push((weight, reference, candidate));
                            means[0] += weight * reference;
                            means[1] += weight * candidate;
                            weight_sum += weight;
                        }
                    }
                    means[0] /= weight_sum;
                    means[1] /= weight_sum;
                    let mut variance_reference = 0.0;
                    let mut variance_candidate = 0.0;
                    let mut covariance = 0.0;
                    for (weight, reference, candidate) in samples {
                        let reference = reference - means[0];
                        let candidate = candidate - means[1];
                        variance_reference += weight * reference * reference / weight_sum;
                        variance_candidate += weight * candidate * candidate / weight_sum;
                        covariance += weight * reference * candidate / weight_sum;
                    }
                    let luminance = (2.0 * means[0] * means[1] + 6.5025)
                        / (means[0] * means[0] + means[1] * means[1] + 6.5025);
                    let structure = (2.0 * covariance + 58.5225)
                        / (variance_reference + variance_candidate + 58.5225);
                    *score += luminance * structure;
                }
            }
            *score /= f64::from(reference.width) * f64::from(reference.height);
        }
        scores
    }

    fn pattern(width: u32, height: u32, seed: u32) -> RgbaImage {
        let pixels = (0..width * height * 4)
            .map(|index| ((index * 17 + seed + index * index) % 256) as u8)
            .collect();
        RgbaImage {
            width,
            height,
            pixels,
        }
    }
}

#[test]
fn matches_direct_population_ssim_for_small_edges_and_streaming_cache_wrap()
-> Result<(), CompareError> {
    for (width, height) in [(1, 1), (1, 3), (2, 1), (3, 2), (11, 11), (13, 27)] {
        let reference = DirectSsim::pattern(width, height, 9);
        let candidate = DirectSsim::pattern(width, height, 31);
        let expected = DirectSsim::measure(&reference, &candidate);
        let actual = Ssim::measure(&reference, &candidate)?;
        for (channel, (&actual, &expected)) in actual.channels.iter().zip(&expected).enumerate() {
            assert!(
                (actual - expected).abs() < 1e-10,
                "{width}x{height} channel {channel}: {actual} != {expected}"
            );
        }
        assert!((actual.mean - expected[..3].iter().sum::<f64>() / 3.0).abs() < 1e-10);
        assert!((actual.rgba_mean - expected.iter().sum::<f64>() / 4.0).abs() < 1e-10);
        assert_eq!(actual.window_size, 11);
        assert_eq!(actual.sigma, 1.5);
        assert_eq!(actual.boundary, "half_sample_symmetric_reflection");
    }
    Ok(())
}

#[test]
fn constant_black_white_has_analytic_luminance_score() -> Result<(), CompareError> {
    let reference = RgbaImage {
        width: 1,
        height: 1,
        pixels: vec![0; 4],
    };
    let candidate = RgbaImage {
        width: 1,
        height: 1,
        pixels: vec![255; 4],
    };
    let result = Ssim::measure(&reference, &candidate)?;
    let expected = 6.5025 / (65025.0 + 6.5025);
    assert!((result.mean - expected).abs() < 1e-12);
    for score in result.channels {
        assert!((score - expected).abs() < 1e-12);
    }
    Ok(())
}

#[test]
fn exact_images_include_constant_and_hidden_color_values() -> Result<(), CompareError> {
    for image in [
        RgbaImage {
            width: 1,
            height: 1,
            pixels: vec![12, 66, 253, 0],
        },
        DirectSsim::pattern(17, 13, 12),
    ] {
        let result = Ssim::measure(&image, &image)?;
        assert_eq!(result.channels, [1.0; 4]);
        assert_eq!(result.mean, 1.0);
        assert_eq!(result.rgba_mean, 1.0);
    }
    Ok(())
}

#[test]
fn transparent_rgb_is_compared_without_alpha_masking() -> Result<(), CompareError> {
    let reference = RgbaImage {
        width: 3,
        height: 2,
        pixels: [0; 4].repeat(6),
    };
    let candidate = RgbaImage {
        width: 3,
        height: 2,
        pixels: [255, 0, 0, 0].repeat(6),
    };
    let result = Ssim::measure(&reference, &candidate)?;
    assert!(result.channels[0] < 0.001);
    assert_eq!(&result.channels[1..], &[1.0; 3]);
    assert!(result.mean < 0.668);
    assert!(result.rgba_mean < 0.751);
    Ok(())
}

#[test]
fn is_symmetric_and_detects_a_local_missing_feature() -> Result<(), CompareError> {
    let reference = DirectSsim::pattern(15, 12, 12);
    let mut candidate = DirectSsim::pattern(15, 12, 12);
    for y in 3..9 {
        for x in 4..10 {
            let index = (y * 15 + x) * 4;
            candidate.pixels[index..index + 4].fill(0);
        }
    }
    let forward = Ssim::measure(&reference, &candidate)?;
    let backward = Ssim::measure(&candidate, &reference)?;
    assert_eq!(forward, backward);
    assert!(forward.mean < 0.99);
    Ok(())
}

#[test]
fn malformed_or_zero_sized_inputs_are_rejected() {
    let reference = DirectSsim::pattern(1, 1, 0);
    for candidate in [
        RgbaImage {
            width: 0,
            height: 0,
            pixels: vec![],
        },
        RgbaImage {
            width: 1,
            height: 1,
            pixels: vec![0; 3],
        },
    ] {
        assert!(Ssim::measure(&reference, &candidate).is_err());
    }
}

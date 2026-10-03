use super::{InkBox, Structural};
use crate::{error::CompareError, image::RgbaImage};

struct Fixture;

impl Fixture {
    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> RgbaImage {
        RgbaImage {
            width,
            height,
            pixels: rgba.repeat(width as usize * height as usize),
        }
    }

    fn set(image: &mut RgbaImage, x: u32, y: u32, rgba: [u8; 4]) {
        let index = (y as usize * image.width as usize + x as usize) * 4;
        image.pixels[index..index + 4].copy_from_slice(&rgba);
    }
}

#[test]
fn diagonal_errors_connect_without_wrapping_between_rows() -> Result<(), CompareError> {
    let reference = Fixture::solid(5, 4, [0; 4]);
    let mut candidate = Fixture::solid(5, 4, [0; 4]);
    for (x, y) in [(0, 1), (1, 2), (2, 3), (4, 0)] {
        Fixture::set(&mut candidate, x, y, [17, 0, 0, 0]);
    }
    let result = Structural::measure(&reference, &candidate, None)?;
    assert_eq!(result.largest_error_component, 3);
    assert_eq!(result.error_component_count, 2);
    assert!(result.ink_bounds.is_none());
    Ok(())
}

#[test]
fn missing_glyph_is_a_single_component_even_on_a_large_canvas() -> Result<(), CompareError> {
    let mut reference = Fixture::solid(256, 128, [0; 4]);
    let candidate = Fixture::solid(256, 128, [0; 4]);
    for y in 10..19 {
        for x in 20..29 {
            Fixture::set(&mut reference, x, y, [255; 4]);
        }
    }
    let result = Structural::measure(&reference, &candidate, Some([0; 4]))?;
    assert_eq!(result.largest_error_component, 81);
    assert_eq!(result.error_component_count, 1);
    let bounds = result
        .ink_bounds
        .ok_or_else(|| CompareError::InvalidArgument("Missing ink result".into()))?;
    assert!(!bounds.same_emptiness);
    assert_eq!(bounds.candidate, None);
    assert_eq!(bounds.edge_deltas, None);
    Ok(())
}

#[test]
fn threshold_edges_and_alpha_fraction_use_pixel_denominator() -> Result<(), CompareError> {
    let reference = Fixture::solid(4, 1, [0; 4]);
    let candidate = RgbaImage {
        width: 4,
        height: 1,
        pixels: vec![16, 0, 0, 8, 0, 0, 0, 9, 17, 0, 0, 0, 0, 0, 0, 0],
    };
    let result = Structural::measure(&reference, &candidate, None)?;
    assert_eq!(result.cluster_error_threshold, 16);
    assert_eq!(result.largest_error_component, 1);
    assert_eq!(result.alpha_error_threshold, 8);
    assert_eq!(result.alpha_changed_pixels, 1);
    assert_eq!(result.alpha_changed_fraction, 0.25);
    Ok(())
}

#[test]
fn signed_channels_never_cancel_each_other() -> Result<(), CompareError> {
    let reference = Fixture::solid(3, 2, [128; 4]);
    let candidate = Fixture::solid(3, 2, [129, 127, 130, 126]);
    let result = Structural::measure(&reference, &candidate, None)?;
    assert_eq!(result.signed_bias, [1.0, -1.0, 2.0, -2.0]);
    assert_eq!(result.largest_error_component, 0);
    assert_eq!(result.error_component_count, 0);
    Ok(())
}

#[test]
fn ink_uses_fixed_rgba_background_including_hidden_rgb_and_image_edges() -> Result<(), CompareError>
{
    let mut reference = Fixture::solid(6, 5, [0; 4]);
    let mut candidate = Fixture::solid(6, 5, [0; 4]);
    Fixture::set(&mut reference, 0, 0, [1, 0, 0, 0]);
    Fixture::set(&mut reference, 4, 3, [0, 0, 0, 1]);
    Fixture::set(&mut candidate, 1, 1, [1, 0, 0, 0]);
    Fixture::set(&mut candidate, 5, 4, [0, 0, 0, 1]);
    let result = Structural::measure(&reference, &candidate, Some([0; 4]))?;
    let bounds = result
        .ink_bounds
        .ok_or_else(|| CompareError::InvalidArgument("Missing ink result".into()))?;
    assert!(bounds.same_emptiness);
    assert_eq!(bounds.edge_deltas, Some([1; 4]));
    assert_eq!(
        bounds.reference,
        Some(InkBox {
            min_x: 0,
            min_y: 0,
            max_x: 4,
            max_y: 3,
        })
    );
    assert_eq!(
        bounds.candidate,
        Some(InkBox {
            min_x: 1,
            min_y: 1,
            max_x: 5,
            max_y: 4,
        })
    );
    Ok(())
}

#[test]
fn empty_bounds_are_explicit_and_colored_background_is_not_inferred() -> Result<(), CompareError> {
    let image = Fixture::solid(3, 2, [12, 25, 50, 255]);
    let result = Structural::measure(&image, &image, Some([12, 25, 50, 255]))?;
    let bounds = result
        .ink_bounds
        .ok_or_else(|| CompareError::InvalidArgument("Missing ink result".into()))?;
    assert!(bounds.same_emptiness);
    assert_eq!(bounds.reference, None);
    assert_eq!(bounds.candidate, None);
    assert_eq!(bounds.edge_deltas, None);
    let full = Structural::measure(&image, &image, Some([0; 4]))?;
    let full_bounds = full
        .ink_bounds
        .ok_or_else(|| CompareError::InvalidArgument("Missing ink result".into()))?;
    assert_eq!(
        full_bounds.reference,
        Some(InkBox {
            min_x: 0,
            min_y: 0,
            max_x: 2,
            max_y: 1,
        })
    );
    Ok(())
}

#[test]
fn rejects_malformed_image_instead_of_partial_statistics() {
    let image = Fixture::solid(1, 1, [0; 4]);
    let malformed = RgbaImage {
        width: 1,
        height: 1,
        pixels: vec![0; 3],
    };
    assert!(Structural::measure(&image, &malformed, None).is_err());
}

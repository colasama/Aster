use serde::Serialize;

use crate::{error::CompareError, image::RgbaImage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct InkBox {
    pub min_x: u32,
    pub min_y: u32,
    pub max_x: u32,
    pub max_y: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct InkBoundsReport {
    pub background: [u8; 4],
    pub reference: Option<InkBox>,
    pub candidate: Option<InkBox>,
    /// Candidate minus reference, ordered left, top, right, bottom.
    pub edge_deltas: Option<[i64; 4]>,
    pub same_emptiness: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StructuralReport {
    pub pixel_count: u64,
    pub cluster_error_threshold: u8,
    pub largest_error_component: u64,
    pub error_component_count: u64,
    pub signed_bias: [f64; 4],
    pub alpha_error_threshold: u8,
    pub alpha_changed_pixels: u64,
    pub alpha_changed_fraction: f64,
    pub ink_bounds: Option<InkBoundsReport>,
}

struct StructuralParameters {
    cluster_error_threshold: u8,
    alpha_error_threshold: u8,
}

impl Default for StructuralParameters {
    fn default() -> Self {
        Self {
            cluster_error_threshold: 16,
            alpha_error_threshold: 8,
        }
    }
}

pub struct Structural;

impl Structural {
    pub fn measure(
        reference: &RgbaImage,
        candidate: &RgbaImage,
        background: Option<[u8; 4]>,
    ) -> Result<StructuralReport, CompareError> {
        reference.validate_pair(candidate)?;
        let parameters = StructuralParameters::default();
        let pixel_count = reference.pixels.len() / 4;
        let mut mask = Vec::new();
        mask.try_reserve_exact(pixel_count)
            .map_err(|error| CompareError::ResourceLimit(format!("Error cluster mask: {error}")))?;
        let mut signed_sum = [0_i128; 4];
        let mut alpha_changed_pixels = 0_u64;
        let mut error_pixels = 0_usize;
        for (reference_pixel, candidate_pixel) in reference
            .pixels
            .chunks_exact(4)
            .zip(candidate.pixels.chunks_exact(4))
        {
            let mut pixel_error = 0_u8;
            for (channel, (&reference_channel, &candidate_channel)) in
                reference_pixel.iter().zip(candidate_pixel).enumerate()
            {
                signed_sum[channel] +=
                    i128::from(candidate_channel) - i128::from(reference_channel);
                pixel_error = pixel_error.max(reference_channel.abs_diff(candidate_channel));
            }
            let significant = pixel_error > parameters.cluster_error_threshold;
            mask.push(u8::from(significant));
            error_pixels += usize::from(significant);
            if reference_pixel[3].abs_diff(candidate_pixel[3]) > parameters.alpha_error_threshold {
                alpha_changed_pixels += 1;
            }
        }
        let (largest_error_component, error_component_count) = Self::components(
            &mut mask,
            reference.width as usize,
            reference.height as usize,
            error_pixels,
        )?;
        Ok(StructuralReport {
            pixel_count: pixel_count as u64,
            cluster_error_threshold: parameters.cluster_error_threshold,
            largest_error_component,
            error_component_count,
            signed_bias: signed_sum.map(|sum| sum as f64 / pixel_count as f64),
            alpha_error_threshold: parameters.alpha_error_threshold,
            alpha_changed_pixels,
            alpha_changed_fraction: alpha_changed_pixels as f64 / pixel_count as f64,
            ink_bounds: background.map(|background| {
                let reference = Self::ink_bounds(reference, background);
                let candidate = Self::ink_bounds(candidate, background);
                let edge_deltas = reference.zip(candidate).map(|(reference, candidate)| {
                    [
                        i64::from(candidate.min_x) - i64::from(reference.min_x),
                        i64::from(candidate.min_y) - i64::from(reference.min_y),
                        i64::from(candidate.max_x) - i64::from(reference.max_x),
                        i64::from(candidate.max_y) - i64::from(reference.max_y),
                    ]
                });
                InkBoundsReport {
                    background,
                    reference,
                    candidate,
                    edge_deltas,
                    same_emptiness: reference.is_none() == candidate.is_none(),
                }
            }),
        })
    }

    fn components(
        mask: &mut [u8],
        width: usize,
        height: usize,
        error_pixels: usize,
    ) -> Result<(u64, u64), CompareError> {
        if error_pixels == 0 {
            return Ok((0, 0));
        }
        let mut pending = Vec::new();
        pending.try_reserve_exact(error_pixels).map_err(|error| {
            CompareError::ResourceLimit(format!("Error cluster traversal: {error}"))
        })?;
        let mut largest = 0_u64;
        let mut component_count = 0_u64;
        for seed in 0..mask.len() {
            if mask[seed] == 0 {
                continue;
            }
            component_count += 1;
            let mut area = 0_u64;
            mask[seed] = 0;
            pending.push(seed);
            while let Some(index) = pending.pop() {
                area += 1;
                let x = index % width;
                let y = index / width;
                for neighbor_y in y.saturating_sub(1)..=(y + 1).min(height - 1) {
                    for neighbor_x in x.saturating_sub(1)..=(x + 1).min(width - 1) {
                        let neighbor = neighbor_y * width + neighbor_x;
                        if mask[neighbor] != 0 {
                            // Mark on insertion: no pixel enters the traversal more than once.
                            mask[neighbor] = 0;
                            pending.push(neighbor);
                        }
                    }
                }
            }
            largest = largest.max(area);
        }
        Ok((largest, component_count))
    }

    fn ink_bounds(image: &RgbaImage, background: [u8; 4]) -> Option<InkBox> {
        let mut bounds: Option<InkBox> = None;
        for (index, pixel) in image.pixels.chunks_exact(4).enumerate() {
            if pixel == background {
                continue;
            }
            let x = (index % image.width as usize) as u32;
            let y = (index / image.width as usize) as u32;
            if let Some(bounds) = &mut bounds {
                bounds.min_x = bounds.min_x.min(x);
                bounds.min_y = bounds.min_y.min(y);
                bounds.max_x = bounds.max_x.max(x);
                bounds.max_y = bounds.max_y.max(y);
            } else {
                bounds = Some(InkBox {
                    min_x: x,
                    min_y: y,
                    max_x: x,
                    max_y: y,
                });
            }
        }
        bounds
    }
}

#[cfg(test)]
mod tests;

use super::CameraTrack;
use crate::EvaluationError;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraOptics {
    pub projection: String,
    pub focal_length: f64,
    pub depth_of_field: bool,
    pub lock_focus_to_zoom: bool,
    pub f_stop: f64,
    pub iris_shape: String,
    pub iris_shape_code: u32,
    pub iris_blades: u32,
    pub render_quality: f64,
    pub zoom: f64,
    pub film_size: f64,
    pub orthographic_size: f64,
    pub focus_distance: f64,
    pub aperture: f64,
    pub blur_level: f64,
    pub focus_area_width: f64,
    pub near_blur_level: f64,
    pub far_blur_level: f64,
    pub iris_rotation: f64,
    pub iris_roundness: f64,
    pub iris_aspect_ratio: f64,
    pub iris_diffraction_fringe: f64,
    pub highlight_gain: f64,
    pub highlight_threshold: f64,
    pub highlight_saturation: f64,
}

impl CameraOptics {
    pub(super) fn evaluate(
        track: &CameraTrack,
        time: f64,
        width: f64,
    ) -> Result<Self, EvaluationError> {
        let film_size = track.film_size.evaluate(time)?;
        let width = if width.is_finite() {
            width.clamp(1.0, 32768.0)
        } else {
            1920.0
        };
        let focal_length = ((track.zoom.evaluate(time)? * film_size) / width).clamp(0.1, 10_000.0);
        let zoom = (focal_length * width) / film_size;
        let aperture = track.aperture.evaluate(time)?;
        let f_stop = (focal_length / (aperture / (72.0 / 25.4))).clamp(0.1, 1000.0);
        let (iris_shape, iris_shape_code, iris_blades) = match track.iris_shape.as_str() {
            "square" => ("square", 2, 4),
            "triangle" => ("triangle", 3, 3),
            "pentagon" => ("pentagon", 4, 5),
            "hexagon" => ("hexagon", 5, 6),
            "heptagon" => ("heptagon", 6, 7),
            "octagon" => ("octagon", 7, 8),
            "nonagon" => ("nonagon", 8, 9),
            "decagon" => ("decagon", 9, 10),
            "circle" => ("circle", 10, 64),
            _ => ("fastRectangle", 1, 4),
        };
        Ok(Self {
            projection: if track.projection == "orthographic" {
                "orthographic"
            } else {
                "perspective"
            }
            .into(),
            focal_length,
            depth_of_field: track.depth_of_field,
            lock_focus_to_zoom: track.lock_focus_to_zoom,
            f_stop,
            iris_shape: iris_shape.into(),
            iris_shape_code,
            iris_blades,
            render_quality: track.render_quality,
            zoom,
            film_size,
            aperture,
            focus_distance: if track.lock_focus_to_zoom {
                zoom
            } else {
                track.focus_distance.evaluate(time)?
            },
            orthographic_size: track.orthographic_size.evaluate(time)?,
            blur_level: track.blur_level.evaluate(time)?,
            focus_area_width: track.focus_area_width.evaluate(time)?,
            near_blur_level: track.near_blur_level.evaluate(time)?,
            far_blur_level: track.far_blur_level.evaluate(time)?,
            iris_rotation: track.iris_rotation.evaluate(time)?,
            iris_roundness: track.iris_roundness.evaluate(time)?,
            iris_aspect_ratio: track.iris_aspect_ratio.evaluate(time)?,
            iris_diffraction_fringe: track.iris_diffraction_fringe.evaluate(time)?,
            highlight_gain: track.highlight_gain.evaluate(time)?,
            highlight_threshold: track.highlight_threshold.evaluate(time)?,
            highlight_saturation: track.highlight_saturation.evaluate(time)?,
        })
    }
    pub fn circle_of_confusion(
        &self,
        camera_depth: f64,
        surface_depth: f64,
        composition_width: f64,
        render_width: f64,
    ) -> f64 {
        if !self.depth_of_field || self.projection == "orthographic" {
            return 0.0;
        }
        let distance = (surface_depth - camera_depth).abs().max(1e-4);
        let focus_distance = self.focus_distance.max(1e-4);
        let signed = distance - focus_distance;
        let defocused = (signed.abs() - self.focus_area_width.max(0.0) * 0.5).max(0.0);
        if defocused == 0.0 {
            return 0.0;
        }
        let side = if signed < 0.0 {
            self.near_blur_level
        } else {
            self.far_blur_level
        };
        let width = if composition_width.is_finite() {
            composition_width.clamp(1.0, 32768.0)
        } else {
            1920.0
        };
        let render = if render_width.is_finite() {
            render_width.clamp(1.0, 32768.0)
        } else {
            composition_width.clamp(1.0, 32768.0)
        };
        let resolution = render / width;
        let radius = self.aperture.max(0.0)
            * 0.5
            * (self.zoom.max(1e-4) / focus_distance)
            * (defocused / distance)
            * (self.blur_level / 100.0)
            * (side / 100.0)
            * resolution;
        let bounded = radius.min(256.0 * resolution);
        if signed < 0.0 { -bounded } else { bounded }
    }
    pub fn sample_count(&self) -> u32 {
        let quality = self.render_quality.clamp(1.0, 100.0);
        (8.0 + (quality / 100.0).powi(2) * 56.0).round() as u32
    }
}

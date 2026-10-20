use crate::{EvaluatedTransform, EvaluationError, EvaluationLimits, ScalarTrack};
use aster_types::editor::{Animatable, Camera};
use serde::{Deserialize, Serialize};
use serde_json::Number;
use std::collections::BTreeMap;

mod optics;
mod rig;
pub use optics::CameraOptics;
pub use rig::{CameraBasis, CameraProjector, ProjectedCameraPoint};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraPose {
    pub mode: String,
    pub position: [f64; 3],
    pub point_of_interest: [f64; 3],
    pub orientation: [f64; 3],
    pub rotation: [f64; 3],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraProjection {
    pub kind: String,
    pub zoom: f64,
    pub orthographic_size: f64,
    pub near: f64,
    pub far: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EvaluatedCamera {
    pub pose: CameraPose,
    pub projection: CameraProjection,
    pub optics: CameraOptics,
}

#[derive(Clone, Debug)]
pub struct CameraTrack {
    mode: String,
    projection: String,
    depth_of_field: bool,
    lock_focus_to_zoom: bool,
    iris_shape: String,
    render_quality: f64,
    point_of_interest: [ScalarTrack; 3],
    orientation: [ScalarTrack; 3],
    zoom: BoundedTrack,
    film_size: BoundedTrack,
    orthographic_size: BoundedTrack,
    focus_distance: BoundedTrack,
    aperture: BoundedTrack,
    blur_level: BoundedTrack,
    focus_area_width: BoundedTrack,
    near_blur_level: BoundedTrack,
    far_blur_level: BoundedTrack,
    iris_rotation: BoundedTrack,
    iris_roundness: BoundedTrack,
    iris_aspect_ratio: BoundedTrack,
    iris_diffraction_fringe: BoundedTrack,
    highlight_gain: BoundedTrack,
    highlight_threshold: BoundedTrack,
    highlight_saturation: BoundedTrack,
}

#[derive(Clone, Debug)]
struct BoundedTrack {
    track: ScalarTrack,
    minimum: f64,
    maximum: f64,
    fallback: f64,
}

impl BoundedTrack {
    fn compile(
        property: &Animatable,
        limits: &EvaluationLimits,
        bounds: [f64; 3],
    ) -> Result<Self, EvaluationError> {
        Ok(Self {
            track: ScalarTrack::compile(property, limits)?,
            minimum: bounds[0],
            maximum: bounds[1],
            fallback: bounds[2],
        })
    }
    fn evaluate(&self, time: f64) -> Result<f64, EvaluationError> {
        let value = self.track.evaluate(time)?;
        Ok(if value.is_finite() {
            value.clamp(self.minimum, self.maximum)
        } else {
            self.fallback
        })
    }
}

impl CameraTrack {
    pub fn compile(
        camera: Option<&Camera>,
        size: [f64; 2],
        limits: &EvaluationLimits,
    ) -> Result<Self, EvaluationError> {
        let defaults;
        let camera = match camera {
            Some(camera) => camera,
            None => {
                defaults = Self::default_settings(size)?;
                &defaults
            }
        };
        Ok(Self {
            mode: camera.mode.clone(),
            projection: camera.projection.clone(),
            depth_of_field: camera.depth_of_field,
            lock_focus_to_zoom: camera.lock_focus_to_zoom,
            iris_shape: camera.iris_shape.clone(),
            render_quality: camera
                .render_quality
                .as_f64()
                .filter(|v| v.is_finite())
                .ok_or_else(|| {
                    EvaluationError::InvalidScene("camera quality must be finite".into())
                })?
                .clamp(1.0, 100.0),
            point_of_interest: Self::compile_vector(&camera.point_of_interest, limits)?,
            orientation: Self::compile_vector(&camera.orientation, limits)?,
            zoom: BoundedTrack::compile(
                &camera.zoom,
                limits,
                [0.1, 1000000.0, 2_666.666_666_666_666_5],
            )?,
            film_size: BoundedTrack::compile(&camera.film_size, limits, [0.1, 1000.0, 36.0])?,
            orthographic_size: BoundedTrack::compile(
                &camera.orthographic_size,
                limits,
                [1.0, 10000000.0, 1080.0],
            )?,
            focus_distance: BoundedTrack::compile(
                &camera.focus_distance,
                limits,
                [0.1, 10000000.0, 2_666.666_666_666_666_5],
            )?,
            aperture: BoundedTrack::compile(
                &camera.aperture,
                limits,
                [0.001, 10000.0, (50.0 / 5.6) * (72.0 / 25.4)],
            )?,
            blur_level: BoundedTrack::compile(&camera.blur_level, limits, [0.0, 1000.0, 100.0])?,
            focus_area_width: BoundedTrack::compile(
                &camera.focus_area_width,
                limits,
                [0.0, 10000000.0, 0.0],
            )?,
            near_blur_level: BoundedTrack::compile(
                &camera.near_blur_level,
                limits,
                [0.0, 1000.0, 100.0],
            )?,
            far_blur_level: BoundedTrack::compile(
                &camera.far_blur_level,
                limits,
                [0.0, 1000.0, 100.0],
            )?,
            iris_rotation: BoundedTrack::compile(
                &camera.iris_rotation,
                limits,
                [-360.0, 360.0, 0.0],
            )?,
            iris_roundness: BoundedTrack::compile(
                &camera.iris_roundness,
                limits,
                [0.0, 100.0, 0.0],
            )?,
            iris_aspect_ratio: BoundedTrack::compile(
                &camera.iris_aspect_ratio,
                limits,
                [1.0, 100.0, 1.0],
            )?,
            iris_diffraction_fringe: BoundedTrack::compile(
                &camera.iris_diffraction_fringe,
                limits,
                [0.0, 100.0, 0.0],
            )?,
            highlight_gain: BoundedTrack::compile(
                &camera.highlight_gain,
                limits,
                [0.0, 100.0, 0.0],
            )?,
            highlight_threshold: BoundedTrack::compile(
                &camera.highlight_threshold,
                limits,
                [0.0, 1.0, 1.0],
            )?,
            highlight_saturation: BoundedTrack::compile(
                &camera.highlight_saturation,
                limits,
                [0.0, 100.0, 100.0],
            )?,
        })
    }
    fn compile_vector(
        properties: &[Animatable; 3],
        limits: &EvaluationLimits,
    ) -> Result<[ScalarTrack; 3], EvaluationError> {
        Ok([
            ScalarTrack::compile(&properties[0], limits)?,
            ScalarTrack::compile(&properties[1], limits)?,
            ScalarTrack::compile(&properties[2], limits)?,
        ])
    }
    pub fn evaluate(
        &self,
        transform: &EvaluatedTransform,
        time: f64,
        width: f64,
    ) -> Result<EvaluatedCamera, EvaluationError> {
        let optics = CameraOptics::evaluate(self, time, width)?;
        Ok(EvaluatedCamera {
            pose: CameraPose {
                mode: self.mode.clone(),
                position: transform.position,
                rotation: transform.rotation,
                point_of_interest: [
                    self.point_of_interest[0].evaluate(time)?,
                    self.point_of_interest[1].evaluate(time)?,
                    self.point_of_interest[2].evaluate(time)?,
                ],
                orientation: [
                    self.orientation[0].evaluate(time)?,
                    self.orientation[1].evaluate(time)?,
                    self.orientation[2].evaluate(time)?,
                ],
            },
            projection: CameraProjection {
                kind: self.projection.clone(),
                zoom: optics.zoom,
                orthographic_size: optics.orthographic_size,
                near: 0.1,
                far: 10_000_000.0,
            },
            optics,
        })
    }
    fn constant(value: f64) -> Result<Animatable, EvaluationError> {
        let value = Number::from_f64(value)
            .ok_or_else(|| EvaluationError::InvalidScene("camera default must be finite".into()))?;
        Ok(Animatable::Static {
            value,
            extensions: BTreeMap::new(),
        })
    }
    fn default_settings(size: [f64; 2]) -> Result<Camera, EvaluationError> {
        let width = if size[0].is_finite() && size[0] > 0.0 {
            size[0]
        } else {
            1920.0
        };
        let height = if size[1].is_finite() && size[1] > 0.0 {
            size[1]
        } else {
            1080.0
        };
        let zoom = (50.0 * width.clamp(1.0, 32768.0)) / 36.0;
        Ok(Camera {
            mode: "twoNode".into(),
            projection: "perspective".into(),
            depth_of_field: false,
            lock_focus_to_zoom: true,
            iris_shape: "fastRectangle".into(),
            render_quality: Number::from(50),
            extensions: BTreeMap::new(),
            point_of_interest: [
                Self::constant(width * 0.5)?,
                Self::constant(height * 0.5)?,
                Self::constant(0.0)?,
            ],
            orientation: [
                Self::constant(0.0)?,
                Self::constant(0.0)?,
                Self::constant(0.0)?,
            ],
            zoom: Self::constant(zoom)?,
            film_size: Self::constant(36.0)?,
            orthographic_size: Self::constant(height)?,
            focus_distance: Self::constant(zoom)?,
            aperture: Self::constant((50.0 / 5.6) * (72.0 / 25.4))?,
            blur_level: Self::constant(100.0)?,
            focus_area_width: Self::constant(0.0)?,
            near_blur_level: Self::constant(100.0)?,
            far_blur_level: Self::constant(100.0)?,
            iris_rotation: Self::constant(0.0)?,
            iris_roundness: Self::constant(0.0)?,
            iris_aspect_ratio: Self::constant(1.0)?,
            iris_diffraction_fringe: Self::constant(0.0)?,
            highlight_gain: Self::constant(0.0)?,
            highlight_threshold: Self::constant(1.0)?,
            highlight_saturation: Self::constant(100.0)?,
        })
    }
    pub fn default_evaluated(
        size: [f64; 2],
        limits: &EvaluationLimits,
    ) -> Result<EvaluatedCamera, EvaluationError> {
        let camera = Self::compile(None, size, limits)?;
        let zoom = camera.zoom.evaluate(0.0)?;
        let transform = EvaluatedTransform {
            position: [size[0] * 0.5, size[1] * 0.5, -zoom],
            rotation: [0.0; 3],
            scale: [100.0; 3],
            anchor: [0.0; 3],
            opacity: 1.0,
        };
        camera.evaluate(&transform, 0.0, size[0])
    }
}

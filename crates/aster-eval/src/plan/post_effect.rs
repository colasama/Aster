use crate::{EvaluatedCamera, EvaluationError, NativePlan};
use aster_render_ir::{
    ContractLevel, DepthEffectMode, ElementType, FrameHeaderSlice, PlanSlice, PostEffect,
    PostEffectInput, PostEffectSlice, PostEffectStatus, SurfaceEffectMode,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DepthSettings {
    pub camera_position: [f64; 3],
    pub camera_forward: [f64; 3],
    pub fog_color: [f64; 3],
    pub fog_density: f64,
    pub fog_start: f64,
    pub focus_distance: f64,
    pub focus_area_width: f64,
    pub aperture: f64,
    pub film_size: f64,
    pub transparency_tier: f64,
    pub zoom: f64,
    pub blur_level: f64,
    pub near_blur_level: f64,
    pub far_blur_level: f64,
    pub iris_shape_code: f64,
    pub iris_rotation: f64,
    pub iris_roundness: f64,
    pub iris_aspect_ratio: f64,
    pub iris_diffraction_fringe: f64,
    pub highlight_gain: f64,
    pub highlight_threshold: f64,
    pub highlight_saturation: f64,
    pub maximum_blur_radius: f64,
    pub sample_count: f64,
}

impl Default for DepthSettings {
    fn default() -> Self {
        Self {
            camera_position: [0.0; 3],
            camera_forward: [0.0, 0.0, 1.0],
            fog_color: [0.08, 0.16, 0.3],
            fog_density: 0.012,
            fog_start: 6.0,
            focus_distance: 2_666.666_666_666_666_5,
            focus_area_width: 0.0,
            aperture: (50.0 / 5.6) * (72.0 / 25.4),
            film_size: 36.0,
            transparency_tier: 2.0,
            zoom: 2_666.666_666_666_666_5,
            blur_level: 100.0,
            near_blur_level: 100.0,
            far_blur_level: 100.0,
            iris_shape_code: 1.0,
            iris_rotation: 0.0,
            iris_roundness: 0.0,
            iris_aspect_ratio: 1.0,
            iris_diffraction_fringe: 0.0,
            highlight_gain: 0.0,
            highlight_threshold: 1.0,
            highlight_saturation: 100.0,
            maximum_blur_radius: 48.0,
            sample_count: 32.0,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DepthAttachments {
    pub scene: bool,
    pub world_position: bool,
    pub transparent_world_position: bool,
    pub peeled_world_position: bool,
    pub front_layer_color: bool,
    pub peeled_layer_color: bool,
    pub motion_blur_source: bool,
}

impl DepthSettings {
    pub fn from_camera(
        camera: &EvaluatedCamera,
        composition_width: f64,
        render_width: f64,
        tier: f64,
    ) -> Self {
        let optics = &camera.optics;
        let scale = Self::bounded(render_width, 1.0, 32768.0)
            / Self::bounded(composition_width, 1.0, 32768.0);
        Self {
            camera_position: camera.pose.position,
            camera_forward: camera.pose.basis().forward,
            focus_distance: optics.focus_distance,
            focus_area_width: optics.focus_area_width,
            aperture: optics.aperture * scale,
            film_size: optics.film_size,
            transparency_tier: tier,
            zoom: optics.zoom,
            blur_level: optics.blur_level,
            near_blur_level: optics.near_blur_level,
            far_blur_level: optics.far_blur_level,
            iris_shape_code: f64::from(optics.iris_shape_code),
            iris_rotation: optics.iris_rotation,
            iris_roundness: optics.iris_roundness,
            iris_aspect_ratio: optics.iris_aspect_ratio,
            iris_diffraction_fringe: optics.iris_diffraction_fringe,
            highlight_gain: optics.highlight_gain,
            highlight_threshold: optics.highlight_threshold,
            highlight_saturation: optics.highlight_saturation,
            maximum_blur_radius: (256.0 * scale).clamp(1.0, 256.0),
            sample_count: f64::from(optics.sample_count()),
            ..Self::default()
        }
    }

    pub fn build(
        &self,
        header: FrameHeaderSlice,
        mode: DepthEffectMode,
        attachments: &DepthAttachments,
    ) -> Result<NativePlan, EvaluationError> {
        use PostEffectInput::*;
        let source = if attachments.motion_blur_source {
            MotionBlur
        } else {
            Scene
        };
        let inputs = [
            source,
            WorldPosition,
            if attachments.transparent_world_position {
                TransparentWorldPosition
            } else {
                WorldPosition
            },
            if attachments.peeled_world_position {
                PeeledWorldPosition
            } else {
                WorldPosition
            },
            if attachments.front_layer_color {
                FrontLayerColor
            } else {
                source
            },
            if attachments.peeled_layer_color {
                PeeledLayerColor
            } else {
                source
            },
        ];
        let b = Self::bounded;
        let finite = |value: f64, fallback| if value.is_finite() { value } else { fallback };
        let values = [
            b(f64::from(header.render_target.width), 1.0, 16384.0),
            b(f64::from(header.render_target.height), 1.0, 16384.0),
            if mode == DepthEffectMode::DepthFog {
                1.0
            } else {
                2.0
            },
            b(self.sample_count, 8.0, 64.0),
            b(self.fog_color[0], 0.0, 16.0),
            b(self.fog_color[1], 0.0, 16.0),
            b(self.fog_color[2], 0.0, 16.0),
            b(self.fog_density, 0.0, 1.0),
            finite(self.camera_position[0], 0.0),
            finite(self.camera_position[1], 0.0),
            finite(self.camera_position[2], 0.0),
            b(self.fog_start, 0.0, 100000.0),
            finite(self.camera_forward[0], 0.0),
            finite(self.camera_forward[1], 0.0),
            finite(self.camera_forward[2], 1.0),
            b(self.focus_distance, 0.001, 10000000.0),
            b(self.focus_area_width, 0.0, 10000000.0),
            b(self.aperture, 0.0, 10000.0),
            b(self.transparency_tier, 0.0, 2.0),
            b(self.zoom, 0.001, 10000000.0),
            b(self.blur_level, 0.0, 1000.0) / 100.0,
            b(self.near_blur_level, 0.0, 1000.0) / 100.0,
            b(self.far_blur_level, 0.0, 1000.0) / 100.0,
            b(self.maximum_blur_radius, 0.0, 256.0),
            b(self.iris_shape_code, 1.0, 10.0),
            b(self.iris_rotation, -360.0, 360.0) * std::f64::consts::PI / 180.0,
            b(self.iris_roundness, 0.0, 100.0) / 100.0,
            b(self.iris_aspect_ratio, 1.0, 100.0),
            b(self.iris_diffraction_fringe, 0.0, 100.0) / 100.0,
            b(self.highlight_gain, 0.0, 100.0) / 100.0,
            b(self.highlight_threshold, 0.0, 1.0),
            b(self.highlight_saturation, 0.0, 100.0) / 100.0,
        ];
        NativePlan::single(
            header,
            ContractLevel::PostEffectSliceV1,
            PlanSlice::PostEffect(PostEffectSlice {
                blob_index: 0,
                status: if attachments.scene && attachments.world_position {
                    PostEffectStatus::Ready
                } else {
                    PostEffectStatus::Skipped
                },
                effect: PostEffect::Depth { mode, inputs },
            }),
            ElementType::U8,
            values
                .into_iter()
                .flat_map(|v| (v as f32).to_le_bytes())
                .collect(),
            Vec::new(),
        )
    }

    pub(super) fn bounded(value: f64, minimum: f64, maximum: f64) -> f64 {
        if value.is_finite() {
            value.clamp(minimum, maximum)
        } else {
            minimum
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SurfacePostSettings {
    pub render_id: f64,
    pub motion_shutter_scale: f64,
    pub resources_available: bool,
}
impl SurfacePostSettings {
    pub fn build(
        &self,
        header: FrameHeaderSlice,
        mode: SurfaceEffectMode,
    ) -> Result<NativePlan, EvaluationError> {
        let id = if self.render_id.is_finite()
            && self.render_id.fract() == 0.0
            && self.render_id > 0.0
        {
            self.render_id.rem_euclid(4294967296.0) as u32
        } else {
            0
        };
        let words = [
            (header.render_target.width as f32).to_bits(),
            (header.render_target.height as f32).to_bits(),
            if mode == SurfaceEffectMode::SelectionIsolation {
                1
            } else {
                2
            },
            id,
            (DepthSettings::bounded(self.motion_shutter_scale, 0.0, 4.0) as f32).to_bits(),
            0,
            0,
            0,
        ];
        NativePlan::single(
            header,
            ContractLevel::PostEffectSliceV1,
            PlanSlice::PostEffect(PostEffectSlice {
                blob_index: 0,
                status: if self.resources_available {
                    PostEffectStatus::Ready
                } else {
                    PostEffectStatus::Skipped
                },
                effect: PostEffect::Surface {
                    mode,
                    inputs: [
                        PostEffectInput::Scene,
                        PostEffectInput::ObjectId,
                        PostEffectInput::MotionVector,
                    ],
                },
            }),
            ElementType::U8,
            words.into_iter().flat_map(u32::to_le_bytes).collect(),
            Vec::new(),
        )
    }
}

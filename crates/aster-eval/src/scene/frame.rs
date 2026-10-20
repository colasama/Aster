use super::{
    EvaluatedSceneLayer, SceneFramePlans, SceneGeometry, SceneProject, TextExposureFrame,
    TextExposureRequest, TextGeometryBounds, TextLayouts,
};
use crate::{
    BufferVisualization, EvaluatedCamera, EvaluationError, FramePlanRequest, MotionSettings,
    ShutterInterval,
};
use std::collections::{BTreeMap, BTreeSet};

/// Raster bounds are supplied at the retained text boundary, including shutter endpoint bounds.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameSceneInputs {
    pub visualization: BufferVisualization,
    pub text_bounds: BTreeMap<String, TextGeometryBounds>,
    pub motion_text_bounds: BTreeMap<String, TextGeometryBounds>,
    pub text_layouts: TextLayouts,
    pub locale: String,
}

pub struct PreparedSceneFrame {
    pub layers: Vec<EvaluatedSceneLayer>,
    pub geometry: SceneGeometry,
    pub plans: SceneFramePlans,
    pub camera: Option<EvaluatedCamera>,
    pub text_exposure: TextExposureFrame,
    pub motion_settings: MotionSettings,
    pub shutter: ShutterInterval,
    pub motion_selection_ids: BTreeSet<String>,
    pub beauty_motion_blur: bool,
    pub motion_blur_requested: bool,
    pub beauty_depth_of_field: bool,
}

impl SceneProject {
    /// Produce current and shutter endpoint geometry from the same immutable project snapshot.
    pub fn prepare_frame_scene(
        &self,
        request: &FramePlanRequest,
        input: &FrameSceneInputs,
    ) -> Result<PreparedSceneFrame, EvaluationError> {
        let current = self.evaluate(&request.composition_id, request.time)?;
        self.prepare_evaluated_frame_scene(request, input, current)
    }

    pub(super) fn prepare_evaluated_frame_scene(
        &self,
        request: &FramePlanRequest,
        input: &FrameSceneInputs,
        current: Vec<EvaluatedSceneLayer>,
    ) -> Result<PreparedSceneFrame, EvaluationError> {
        let index = self.composition_index(&request.composition_id)?;
        let composition = &self.project.compositions[index];
        // Validate time and target bounds before collecting geometry or temporal inputs.
        let header = request.header(composition)?;
        header
            .target
            .validate(&aster_render_ir::DecodeLimits::default())
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        header
            .render_target
            .validate(&aster_render_ir::DecodeLimits::default())
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let beauty = matches!(input.visualization, BufferVisualization::Beauty);
        let text_exposure = if beauty {
            self.text_exposure_scenes(
                &TextExposureRequest {
                    composition_id: request.composition_id.clone(),
                    time: request.time,
                    resolution_scale: (f64::from(request.render_target.width)
                        / self.compositions[index].size[0])
                        .max(
                            f64::from(request.render_target.height)
                                / self.compositions[index].size[1],
                        ),
                    locale: input.locale.clone(),
                },
                &input.text_layouts,
                current,
                |time| self.evaluate(&request.composition_id, time),
            )?
        } else {
            TextExposureFrame {
                sample_count: 0,
                plans: BTreeMap::new(),
                exposure_scene_layers: Vec::new(),
                render_scene_layers: current,
            }
        };
        let layers = text_exposure.render_scene_layers.clone();
        let camera = self.camera(&request.composition_id, request.time)?;
        let geometry = self.geometry_for_scene(
            &request.composition_id,
            request.time,
            &layers,
            &input.text_bounds,
        )?;
        let motion_selection_ids = self.evaluated_motion_selection_ids(&layers, &geometry)?;
        let motion_settings = MotionSettings::normalize(composition.motion_blur.value());
        let enabled = motion_settings.enabled
            && motion_settings.shutter_angle > 0.0
            && !motion_selection_ids.is_empty();
        let beauty_motion_blur = beauty && enabled;
        let motion_blur_requested = enabled
            && (beauty
                || matches!(
                    input.visualization,
                    BufferVisualization::MotionVector | BufferVisualization::VectorMotionBlur
                ));
        let rate = Self::number(&composition.frame_rate.numerator)?
            / Self::number(&composition.frame_rate.denominator)?;
        let shutter = motion_settings.interval(request.time, rate, None);
        let mut plans = self.plan_geometry_scene(request, &layers, &geometry)?;
        if motion_blur_requested {
            let open = self.geometry_at(
                &request.composition_id,
                shutter.open_time,
                &input.motion_text_bounds,
            )?;
            let close = self.geometry_at(
                &request.composition_id,
                shutter.close_time,
                &input.motion_text_bounds,
            )?;
            plans = plans.with_motion(&geometry.motion_vectors(
                &open,
                &close,
                Some(&motion_selection_ids),
            )?)?;
        }
        let beauty_depth_of_field = beauty
            && camera
                .as_ref()
                .is_some_and(|c| c.optics.depth_of_field && c.projection.kind == "perspective");
        Ok(PreparedSceneFrame {
            layers,
            geometry,
            plans,
            camera,
            text_exposure,
            motion_settings,
            shutter,
            motion_selection_ids,
            beauty_motion_blur,
            motion_blur_requested,
            beauty_depth_of_field,
        })
    }
}

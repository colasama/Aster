mod samples;

use super::{EvaluatedSceneLayer, SceneProject};
use crate::{EvaluationError, MotionSettings, TextLayoutUnit};
pub use samples::{TextExposurePlan, TextExposureSample};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

/// Layout stays at the supplied-raster boundary, keyed by source composition and authoring layer.
pub type TextLayouts = BTreeMap<String, BTreeMap<String, Vec<TextLayoutUnit>>>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextExposureRequest {
    pub composition_id: String,
    pub time: f64,
    pub resolution_scale: f64,
    pub locale: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextExposureFrame {
    pub sample_count: u32,
    pub plans: BTreeMap<String, TextExposurePlan>,
    pub exposure_scene_layers: Vec<EvaluatedSceneLayer>,
    pub render_scene_layers: Vec<EvaluatedSceneLayer>,
}

impl SceneProject {
    pub fn text_exposure_frame(
        &self,
        request: &TextExposureRequest,
        layouts: &TextLayouts,
    ) -> Result<TextExposureFrame, EvaluationError> {
        let current = self.evaluate(&request.composition_id, request.time)?;
        self.text_exposure_scenes(request, layouts, current, |time| {
            self.evaluate(&request.composition_id, time)
        })
    }

    pub(super) fn text_exposure_scenes(
        &self,
        request: &TextExposureRequest,
        layouts: &TextLayouts,
        current: Vec<EvaluatedSceneLayer>,
        evaluate: impl Fn(f64) -> Result<Vec<EvaluatedSceneLayer>, EvaluationError>,
    ) -> Result<TextExposureFrame, EvaluationError> {
        let index = self.composition_index(&request.composition_id)?;
        let composition = &self.project.compositions[index];
        let settings = MotionSettings::normalize(composition.motion_blur.value());
        let empty = || TextExposureFrame {
            sample_count: 0,
            plans: BTreeMap::new(),
            exposure_scene_layers: Vec::new(),
            render_scene_layers: current.clone(),
        };
        if !settings.enabled
            || settings.shutter_angle <= 0.0
            || !self.contains_motion_text(index, &mut BTreeSet::new())
        {
            return Ok(empty());
        }
        let rate = Self::number(&composition.frame_rate.numerator)?
            / Self::number(&composition.frame_rate.denominator)?;
        let base = settings.interval(request.time, rate, None);
        let base_scenes = base
            .sample_times
            .iter()
            .map(|t| evaluate(*t))
            .collect::<Result<Vec<_>, _>>()?;
        let open = evaluate(base.open_time)?;
        let close = evaluate(base.close_time)?;
        let probe_sets: Vec<_> = std::iter::once(open.as_slice())
            .chain(base_scenes.iter().map(Vec::as_slice))
            .chain(std::iter::once(close.as_slice()))
            .collect();
        let candidates = self.animated_text_union(
            &std::iter::once(current.as_slice())
                .chain(probe_sets.iter().copied())
                .collect::<Vec<_>>(),
        )?;
        if candidates.is_empty() {
            return Ok(empty());
        }
        let probes: Vec<_> = probe_sets
            .iter()
            .map(|s| TextExposureFrame::by_resource(s))
            .collect();
        let mut maximum: f64 = 0.0;
        for scene in candidates.values() {
            let times = probes
                .iter()
                .filter_map(|p| p.get(scene.resource_instance_id.as_str()))
                .map(|s| self.text_source_time(s))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .flatten()
                .collect::<Vec<_>>();
            if times.len() < 2 {
                continue;
            }
            let source = self.composition_index(&scene.source_composition_id)?;
            let layer = self.compositions[source].layer_indices[&scene.layer_id];
            let Some(text) = &self.compositions[source].layers[layer].text else {
                continue;
            };
            let units = layouts
                .get(&scene.source_composition_id)
                .and_then(|c| c.get(&scene.layer_id))
                .ok_or_else(|| {
                    EvaluationError::InvalidScene("missing supplied text layout".into())
                })?;
            let mut travel = 0.0;
            for pair in times.windows(2) {
                travel += text.pixel_travel(
                    &self.project.compositions[source].layers[layer],
                    units,
                    [pair[0], pair[1]],
                    request.resolution_scale,
                )?;
            }
            maximum = maximum.max(travel);
        }
        let count = settings.adaptive_samples(maximum);
        let interval = settings.interval(request.time, rate, Some(count));
        let scenes = if count as usize == base_scenes.len() {
            base_scenes
        } else {
            interval
                .sample_times
                .iter()
                .map(|t| evaluate(*t))
                .collect::<Result<Vec<_>, _>>()?
        };
        let candidates = self.animated_text_union(
            &std::iter::once(current.as_slice())
                .chain(scenes.iter().map(Vec::as_slice))
                .collect::<Vec<_>>(),
        )?;
        let sampled: Vec<_> = scenes
            .iter()
            .map(|s| TextExposureFrame::by_resource(s))
            .collect();
        let mut plans = BTreeMap::new();
        for id in candidates.keys() {
            let times = sampled
                .iter()
                .map(|s| match s.get(id.as_str()) {
                    Some(scene) => self.text_source_time(scene),
                    None => Ok(None),
                })
                .collect::<Result<Vec<_>, _>>()?;
            let plan = TextExposurePlan::from_times(request.time, &times)?;
            if plan.samples.len() <= 1 && plan.transparent_weight == 0.0 {
                continue;
            }
            plans.insert(id.clone(), plan);
        }
        TextExposureFrame::assemble(
            current,
            &scenes,
            &interval.sample_times,
            plans,
            request,
            &composition
                .layers
                .iter()
                .enumerate()
                .map(|(i, l)| (l.id.clone(), i))
                .collect(),
        )
    }

    fn contains_motion_text(&self, index: usize, visited: &mut BTreeSet<usize>) -> bool {
        if !visited.insert(index) {
            return false;
        }
        for (layer, compiled) in self.project.compositions[index]
            .layers
            .iter()
            .zip(&self.compositions[index].layers)
        {
            if !layer.visible {
                continue;
            }
            if layer.kind == "text"
                && layer.motion_blur.value() == Some(&true)
                && compiled
                    .text
                    .as_ref()
                    .and_then(|t| t.cache_time(0.0))
                    .is_some()
            {
                return true;
            }
            if let Some(nested) = compiled.nested
                && self.contains_motion_text(nested, visited)
            {
                return true;
            }
        }
        false
    }

    fn text_source_time(
        &self,
        scene: &EvaluatedSceneLayer,
    ) -> Result<Option<f64>, EvaluationError> {
        let source = self.composition_index(&scene.source_composition_id)?;
        let index = self.compositions[source].layer_indices[&scene.layer_id];
        if self.project.compositions[source].layers[index].kind != "text" {
            return Ok(None);
        }
        let compiled = &self.compositions[source].layers[index];
        let time = compiled.clock.evaluate(scene.local_time, f64::INFINITY)?;
        Ok(compiled.text.as_ref().and_then(|t| t.cache_time(time)))
    }

    fn animated_text_union(
        &self,
        sets: &[&[EvaluatedSceneLayer]],
    ) -> Result<BTreeMap<String, EvaluatedSceneLayer>, EvaluationError> {
        let mut result = BTreeMap::new();
        for scene in sets.iter().flat_map(|s| s.iter()) {
            let source = self.composition_index(&scene.source_composition_id)?;
            let index = self.compositions[source].layer_indices[&scene.layer_id];
            if self.project.compositions[source].layers[index]
                .motion_blur
                .value()
                == Some(&true)
                && self.text_source_time(scene)?.is_some()
            {
                result
                    .entry(scene.resource_instance_id.clone())
                    .or_insert_with(|| scene.clone());
            }
        }
        Ok(result)
    }
}

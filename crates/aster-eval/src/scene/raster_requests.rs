use super::{EvaluatedSceneLayer, SceneProject, TextExposurePlan};
use crate::{EvaluationError, TextAnimatorTrack};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetainedRasterContext {
    pub resolution_scale: f64,
    pub maximum_dimension: u32,
    pub maximum_pixels: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetainedRasterRequest {
    pub composition_id: String,
    pub layer_id: String,
    pub instance_id: String,
    #[serde(flatten)]
    pub raster: RetainedRasterKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RetainedRasterKind {
    Text {
        source_time: f64,
        frame_rate: f64,
        resolution_scale: f64,
        exposure: Option<TextExposurePlan>,
    },
    Svg {
        source_id: String,
        width: u32,
        height: u32,
    },
    Psd {
        source_id: String,
    },
}

impl SceneProject {
    /// Keep preparation order, including shared cloner instances whose final request owns bounds.
    /// The retained raster provider receives source addresses and native sampling decisions only.
    pub fn retained_raster_requests(
        &self,
        composition_id: &str,
        scenes: &[EvaluatedSceneLayer],
        context: &RetainedRasterContext,
        exposure: &BTreeMap<String, TextExposurePlan>,
    ) -> Result<Vec<RetainedRasterRequest>, EvaluationError> {
        let composition = &self.project.compositions[self.composition_index(composition_id)?];
        let frame_rate = Self::number(&composition.frame_rate.numerator)?
            / Self::number(&composition.frame_rate.denominator)?;
        if !frame_rate.is_finite()
            || frame_rate <= 0.0
            || !context.resolution_scale.is_finite()
            || !(0.0..=64.0).contains(&context.resolution_scale)
            || !(1..=8192).contains(&context.maximum_dimension)
            || !(1..=67_108_864).contains(&context.maximum_pixels)
            || scenes.len() > self.limits.cloners.max_cloner_instances
        {
            return Err(EvaluationError::InvalidScene(
                "retained raster request limits".into(),
            ));
        }
        let sources: BTreeMap<_, _> = self
            .project
            .sources
            .value()
            .into_iter()
            .flatten()
            .map(|s| (&s.id, s))
            .collect();
        let mut requests = Vec::new();
        for scene in scenes {
            let composition = self.composition_index(&scene.source_composition_id)?;
            let index = *self.compositions[composition]
                .layer_indices
                .get(&scene.layer_id)
                .ok_or_else(|| EvaluationError::InvalidScene("unknown raster layer".into()))?;
            let layer = &self.project.compositions[composition].layers[index];
            let compiled = &self.compositions[composition].layers[index];
            let raster = if layer.kind == "text" {
                let magnification = scene.transform.scale[0]
                    .abs()
                    .max(scene.transform.scale[1].abs())
                    / 100.0;
                RetainedRasterKind::Text {
                    source_time: compiled.clock.evaluate(scene.local_time, f64::INFINITY)?,
                    frame_rate,
                    resolution_scale: TextAnimatorTrack::raster_scale(
                        context.resolution_scale * magnification,
                    ),
                    exposure: exposure.get(&scene.resource_instance_id).cloned(),
                }
            } else {
                let Some(source) = layer.source_id.value().and_then(|id| sources.get(id)) else {
                    continue;
                };
                match source.kind.as_str() {
                    "svg" => {
                        // SVG density follows the authored layer transform; text uses the composed scene scale.
                        let transform = compiled.transform.evaluate(scene.local_time)?;
                        let [width, height] = context.svg_target(compiled.size, transform.scale)?;
                        RetainedRasterKind::Svg {
                            source_id: source.id.clone(),
                            width,
                            height,
                        }
                    }
                    "psd" => RetainedRasterKind::Psd {
                        source_id: source.id.clone(),
                    },
                    _ => continue,
                }
            };
            requests.push(RetainedRasterRequest {
                composition_id: scene.source_composition_id.clone(),
                layer_id: scene.layer_id.clone(),
                instance_id: scene.resource_instance_id.clone(),
                raster,
            });
        }
        Ok(requests)
    }
}

impl RetainedRasterContext {
    fn svg_target(&self, size: [f64; 2], scale: [f64; 3]) -> Result<[u32; 2], EvaluationError> {
        let magnification = scale[0].abs().max(scale[1].abs()) / 100.0;
        let display = size.map(|s| s.abs() * magnification * self.resolution_scale.max(1.0));
        if display.iter().any(|v| !v.is_finite()) {
            return Err(EvaluationError::InvalidScene(
                "nonfinite SVG raster extent".into(),
            ));
        }
        let largest = display[0].max(display[1]).max(1.0);
        let bucket = 1.25_f64
            .powf((largest.ln() / 1.25_f64.ln()).ceil())
            .min(f64::from(self.maximum_dimension));
        let requested = display.map(|v| (v * (bucket / largest)).ceil().max(1.0));
        let downsample = (f64::from(self.maximum_dimension) / requested[0])
            .min(f64::from(self.maximum_dimension) / requested[1])
            .min((self.maximum_pixels as f64 / (requested[0] * requested[1])).sqrt())
            .min(1.0);
        Ok(requested.map(|v| (v * downsample).floor().max(1.0) as u32))
    }
}

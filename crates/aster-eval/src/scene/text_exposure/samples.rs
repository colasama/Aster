use super::{EvaluatedSceneLayer, TextExposureFrame, TextExposureRequest};
use crate::{EvaluationError, NativePlan, TextCollation};
use aster_render_ir::{
    CompositionIdentity, ContractLevel, ElementType, FrameHeaderSlice, PlanSlice,
    TemporalTextFormat, TemporalTextSamplesSlice,
};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextExposureSample {
    pub local_time: f64,
    pub weight: f64,
    pub time_bucket: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextExposurePlan {
    pub frame_time: f64,
    pub sample_count: u32,
    pub samples: Vec<TextExposureSample>,
    pub transparent_weight: f64,
}

impl TextExposurePlan {
    pub(super) fn from_times(time: f64, times: &[Option<f64>]) -> Result<Self, EvaluationError> {
        if times.is_empty() || times.len() > 128 || !time.is_finite() {
            return Err(EvaluationError::InvalidScene(
                "text exposure sample budget".into(),
            ));
        }
        let mut samples: Vec<TextExposureSample> = Vec::new();
        let mut counts: Vec<u32> = Vec::new();
        let mut transparent = 0;
        for time in times {
            let Some(time) = time else {
                transparent += 1;
                continue;
            };
            let scaled = time * 1_000_000.0;
            let bucket = scaled.floor() + f64::from(scaled - scaled.floor() >= 0.5);
            if !scaled.is_finite() || bucket.abs() > 9_007_199_254_740_991.0 {
                return Err(EvaluationError::InvalidScene(
                    "text exposure time bucket out of range".into(),
                ));
            }
            if let Some(index) = samples.iter().position(|s| s.time_bucket == bucket) {
                counts[index] += 1;
            } else {
                samples.push(TextExposureSample {
                    local_time: *time,
                    weight: 0.0,
                    time_bucket: bucket,
                });
                counts.push(1);
            }
        }
        for (sample, count) in samples.iter_mut().zip(counts) {
            sample.weight = f64::from(count) / times.len() as f64;
        }
        Ok(Self {
            frame_time: time,
            sample_count: times.len() as u32,
            samples,
            transparent_weight: f64::from(transparent) / times.len() as f64,
        })
    }

    pub fn plan(
        &self,
        header: FrameHeaderSlice,
        resource_instance_id: String,
        exposure_only: bool,
    ) -> Result<NativePlan, EvaluationError> {
        let bytes = [self.frame_time, self.transparent_weight]
            .into_iter()
            .chain(
                self.samples
                    .iter()
                    .flat_map(|s| [s.local_time, s.weight, s.time_bucket]),
            )
            .flat_map(f64::to_le_bytes)
            .collect();
        NativePlan::single(
            header,
            ContractLevel::TemporalTextSamplesSliceV1,
            PlanSlice::TemporalTextSamples(TemporalTextSamplesSlice {
                blob_index: 0,
                resource_instance_id: CompositionIdentity::Unicode(resource_instance_id),
                sample_count: self.sample_count,
                unique_sample_count: self.samples.len() as u32,
                exposure_only,
                sample_format: TemporalTextFormat::Rgba8UnormSrgb,
                accumulation_format: TemporalTextFormat::Rgba16Float,
                resolve_format: TemporalTextFormat::Rgba8UnormSrgb,
            }),
            ElementType::U8,
            bytes,
            Vec::new(),
        )
    }
}

#[derive(Clone)]
struct Representative {
    scene: EvaluatedSceneLayer,
    distance: f64,
    order: usize,
}

impl TextExposureFrame {
    pub(super) fn by_resource(
        scenes: &[EvaluatedSceneLayer],
    ) -> BTreeMap<&str, &EvaluatedSceneLayer> {
        let mut result = BTreeMap::new();
        for scene in scenes {
            result
                .entry(scene.resource_instance_id.as_str())
                .or_insert(scene);
        }
        result
    }

    pub(super) fn assemble(
        current: Vec<EvaluatedSceneLayer>,
        scenes: &[Vec<EvaluatedSceneLayer>],
        times: &[f64],
        plans: BTreeMap<String, TextExposurePlan>,
        request: &TextExposureRequest,
        order: &BTreeMap<String, usize>,
    ) -> Result<Self, EvaluationError> {
        let ids: BTreeSet<_> = current
            .iter()
            .map(|s| s.resource_instance_id.as_str())
            .collect();
        // A vector preserves first encounter order, including equal-distance shutter samples.
        let mut representatives: Vec<Representative> = Vec::new();
        let mut indices = BTreeMap::new();
        for (sample, time_at_sample) in scenes.iter().zip(times) {
            let distance = (*time_at_sample - request.time).abs();
            for (order, scene) in sample.iter().enumerate() {
                if !plans.contains_key(&scene.resource_instance_id)
                    || ids.contains(scene.resource_instance_id.as_str())
                {
                    continue;
                }
                let representative = Representative {
                    scene: scene.clone(),
                    distance,
                    order,
                };
                if let Some(index) = indices.get(&scene.resource_instance_id).copied() {
                    let existing: &mut Representative = &mut representatives[index];
                    if distance < existing.distance {
                        *existing = representative;
                    }
                } else {
                    indices.insert(scene.resource_instance_id.clone(), representatives.len());
                    representatives.push(representative);
                }
            }
        }
        let collation = TextCollation::new(&request.locale)?;
        let exposure = Self::ordered(representatives.clone(), order, &collation);
        let rendered = Self::ordered(
            current
                .into_iter()
                .enumerate()
                .map(|(order, scene)| Representative {
                    scene,
                    distance: 0.0,
                    order,
                })
                .chain(representatives)
                .collect(),
            order,
            &collation,
        );
        Ok(Self {
            sample_count: times.len() as u32,
            plans,
            exposure_scene_layers: exposure,
            render_scene_layers: rendered,
        })
    }

    fn ordered(
        mut scenes: Vec<Representative>,
        composition_order: &BTreeMap<String, usize>,
        collation: &TextCollation,
    ) -> Vec<EvaluatedSceneLayer> {
        let key = |r: &Representative| {
            (
                composition_order
                    .get(&r.scene.selection_id)
                    .copied()
                    .unwrap_or(usize::MAX),
                r.order,
            )
        };
        scenes.sort_by(|a, b| {
            key(a)
                .cmp(&key(b))
                .then_with(|| collation.compare(&a.scene.instance_id, &b.scene.instance_id))
        });
        scenes.into_iter().map(|r| r.scene).collect()
    }
}

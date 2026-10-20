use super::{
    EvaluatedSceneLayer, RenderIdentity, RootResourceBindings, SceneFramePlans, SceneProject,
};
use crate::{EvaluationError, NativePlan};
use aster_render_ir::{
    AuxiliaryDraw, AuxiliarySlice, AuxiliaryStatus, CompositionIdentity, ContractLevel,
    DecodeLimits, ElementType, PlanSlice, RootTextureReference,
};
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet};

/// Observed allocation state is explicit so planning never consults a previous rendered frame.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuxiliaryBudget {
    pub enabled: bool,
    pub depth_available: bool,
    pub tier: i8,
    pub estimated_bytes: u64,
    pub id_buffer_bytes: u64,
    pub motion_buffer_bytes: u64,
    pub byte_budget: u64,
}
impl AuxiliaryBudget {
    pub fn outcome(
        &self,
        draw_count: usize,
        vertex_count: u32,
    ) -> Result<AuxiliaryStatus, EvaluationError> {
        if !self.enabled || !self.depth_available {
            return Ok(AuxiliaryStatus::Unavailable);
        }
        if !(-1..=2).contains(&self.tier) || draw_count > 65536 {
            return Err(EvaluationError::InvalidScene(
                "invalid auxiliary allocation state".into(),
            ));
        }
        let id_capacity = (draw_count as u64 * 8).max(8).next_power_of_two();
        let motion_capacity = (u64::from(vertex_count) * 8).max(8).next_power_of_two();
        let planned = self
            .estimated_bytes
            .checked_add(self.id_buffer_bytes.max(id_capacity))
            .and_then(|n| n.checked_add(self.motion_buffer_bytes.max(motion_capacity)))
            .ok_or_else(|| {
                EvaluationError::InvalidScene("auxiliary allocation arithmetic overflow".into())
            })?;
        Ok(if planned > self.byte_budget {
            AuxiliaryStatus::Cleared
        } else {
            AuxiliaryStatus::Drawn
        })
    }
}

impl SceneProject {
    pub fn plan_auxiliary(
        &self,
        scene: &SceneFramePlans,
        layers: &[EvaluatedSceneLayer],
        bindings: &RootResourceBindings,
        budget: &AuxiliaryBudget,
        generators: &[String],
    ) -> Result<NativePlan, EvaluationError> {
        scene
            .scene
            .metadata
            .validate(&DecodeLimits::default())
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        let Some(PlanSlice::SceneBuffers(buffers)) = scene.scene.metadata.slices.first() else {
            return Err(EvaluationError::InvalidScene(
                "missing auxiliary scene geometry".into(),
            ));
        };
        let status = budget.outcome(buffers.draws.len(), buffers.vertex_count)?;
        if status != AuxiliaryStatus::Drawn {
            return NativePlan::single(
                scene.scene.metadata.header.clone(),
                ContractLevel::AuxiliarySliceV1,
                PlanSlice::Auxiliary(AuxiliarySlice {
                    blob_index: 0,
                    status,
                    tier: if status == AuxiliaryStatus::Unavailable {
                        -1
                    } else {
                        budget.tier
                    },
                    vertex_count: 0,
                    motion: false,
                    draws: Vec::new(),
                    generators: Vec::new(),
                }),
                ElementType::U8,
                vec![0; 4],
                Vec::new(),
            );
        }
        if generators.len() > 65536 {
            return Err(EvaluationError::InvalidScene(
                "auxiliary generator budget".into(),
            ));
        }
        let by_instance: BTreeMap<_, _> =
            layers.iter().map(|s| (s.instance_id.as_str(), s)).collect();
        let mut draws = Vec::new();
        let mut resources = BTreeSet::new();
        let mut bytes = Vec::new();
        for draw in &buffers.draws {
            let CompositionIdentity::Unicode(id) = &draw.instance_id else {
                return Err(EvaluationError::InvalidScene(
                    "auxiliary native instance identity".into(),
                ));
            };
            let CompositionIdentity::Unicode(selection) = &draw.selection_id else {
                return Err(EvaluationError::InvalidScene(
                    "auxiliary native selection identity".into(),
                ));
            };
            let layer = by_instance.get(id.as_str()).ok_or_else(|| {
                EvaluationError::InvalidScene("auxiliary draw source is absent".into())
            })?;
            let source = self.composition_index(&layer.source_composition_id)?;
            let index = self.compositions[source].layer_indices[&layer.layer_id];
            bytes.extend_from_slice(&RenderIdentity::encode(selection).to_le_bytes());
            bytes.extend_from_slice(
                &self.compositions[source].layers[index]
                    .material_id
                    .to_le_bytes(),
            );
            let texture = if bindings.surfaces.contains_key(id) {
                RootTextureReference::Surface {
                    instance_id: draw.instance_id.clone(),
                }
            } else if let Some(Some(hash)) = bindings.media.get(id) {
                resources.insert(hash.clone());
                RootTextureReference::Media { hash: hash.clone() }
            } else {
                RootTextureReference::None
            };
            draws.push(AuxiliaryDraw {
                instance_id: draw.instance_id.clone(),
                first_vertex: draw.first_vertex,
                vertex_count: draw.vertex_count,
                texture,
            });
        }
        if buffers.motion_vectors {
            let offset = 592_u64 + u64::from(buffers.vertex_count) * 160;
            let offset = usize::try_from(offset)
                .map_err(|_| EvaluationError::InvalidScene("auxiliary motion offset".into()))?;
            let source = scene
                .scene
                .blobs
                .get(buffers.blob_index as usize)
                .ok_or_else(|| {
                    EvaluationError::InvalidScene("missing auxiliary motion source".into())
                })?;
            scene
                .scene
                .metadata
                .validate_blob(buffers.blob_index as usize, source)
                .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
            bytes.extend_from_slice(
                source.get(offset..).ok_or_else(|| {
                    EvaluationError::InvalidScene("auxiliary motion range".into())
                })?,
            );
        }
        bytes.resize(bytes.len().max(4), 0);
        NativePlan::single(
            scene.scene.metadata.header.clone(),
            ContractLevel::AuxiliarySliceV1,
            PlanSlice::Auxiliary(AuxiliarySlice {
                blob_index: 0,
                status,
                tier: budget.tier,
                vertex_count: buffers.vertex_count,
                motion: buffers.motion_vectors,
                draws,
                generators: generators
                    .iter()
                    .map(|id| CompositionIdentity::Unicode(id.clone()))
                    .collect(),
            }),
            ElementType::U8,
            bytes,
            resources.into_iter().collect(),
        )
    }
}

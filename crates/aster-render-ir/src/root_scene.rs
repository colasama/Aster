use crate::{
    BlobDescriptor, CompositionIdentity, EffectBlendMode, EffectExecutionRoute, ElementType,
    IrError, PlanSlice, ResourceHash,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RootTextureReference {
    None,
    Pending,
    Media { hash: ResourceHash },
    Surface { instance_id: CompositionIdentity },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RootDrawRecord {
    pub instance_id: CompositionIdentity,
    pub first_vertex: u32,
    pub vertex_count: u32,
    pub blend_mode: EffectBlendMode,
    pub texture: RootTextureReference,
    #[serde(deserialize_with = "Option::deserialize")]
    pub material_blob_index: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RootPassGroup {
    Composition,
    Geometry,
    Generator,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RootLoadOp {
    Clear,
    Load,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RootStoreOp {
    Store,
    Discard,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RootCommandRecord {
    BeginScene {
        group: RootPassGroup,
        color_load: RootLoadOp,
        color_store: RootStoreOp,
        depth_load: RootLoadOp,
        depth_store: RootStoreOp,
        clear_index: u32,
    },
    EndScene,
    BeginLayer {
        effect_blob_index: u32,
    },
    FinishLayer,
    Adjustment {
        effect_blob_index: u32,
    },
    Geometry {
        draw_index: u32,
        blend_mode: EffectBlendMode,
    },
    Generator {
        instance_id: CompositionIdentity,
        blend_mode: EffectBlendMode,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RootSceneCommandsSlice {
    pub blob_index: u32,
    pub draws: Vec<RootDrawRecord>,
    pub commands: Vec<RootCommandRecord>,
}

impl RootSceneCommandsSlice {
    pub fn validate(
        &self,
        blob: &BlobDescriptor,
        slices: &[PlanSlice],
        resources: &[ResourceHash],
    ) -> Result<(), IrError> {
        if self.commands.is_empty() || self.commands.len() > 65_536 || self.draws.len() > 65_536 {
            return Err(IrError::InvalidRootScene("command/draw count".to_owned()));
        }
        for draw in &self.draws {
            draw.instance_id.validate()?;
            draw.first_vertex
                .checked_add(draw.vertex_count)
                .ok_or(IrError::ArithmeticOverflow)?;
            match &draw.texture {
                RootTextureReference::Media { hash } => {
                    hash.validate()?;
                    if !resources.contains(hash) {
                        return Err(IrError::InvalidRootScene("undeclared media".to_owned()));
                    }
                }
                RootTextureReference::Surface { instance_id } => instance_id.validate()?,
                _ => {}
            }
            if let Some(index) = draw.material_blob_index
                && !slices
                    .iter()
                    .any(|s| matches!(s, PlanSlice::MaterialBinding(m) if m.blob_index == index))
            {
                return Err(IrError::InvalidRootScene("material reference".to_owned()));
            }
        }
        let mut scene_open = false;
        let mut layer_id: Option<CompositionIdentity> = None;
        let mut clear_count = 0_u32;
        for (index, command) in self.commands.iter().enumerate() {
            match command {
                RootCommandRecord::BeginScene {
                    group,
                    color_load,
                    depth_load,
                    clear_index,
                    ..
                } => {
                    if scene_open
                        || layer_id.is_some()
                        || (*group == RootPassGroup::Composition) != (index == 0)
                        || (index == 0
                            && (*color_load != RootLoadOp::Clear
                                || *depth_load != RootLoadOp::Clear))
                        || *clear_index != clear_count
                    {
                        return Err(IrError::InvalidRootScene("scene pass boundary".to_owned()));
                    }
                    clear_count += 1;
                    scene_open = true;
                }
                RootCommandRecord::EndScene => {
                    if !scene_open || layer_id.is_some() {
                        return Err(IrError::InvalidRootScene("unmatched scene end".to_owned()));
                    }
                    scene_open = false;
                }
                RootCommandRecord::FinishLayer => {
                    if scene_open || layer_id.is_none() {
                        return Err(IrError::InvalidRootScene("unmatched layer end".to_owned()));
                    }
                    layer_id = None;
                }
                RootCommandRecord::BeginLayer { effect_blob_index }
                | RootCommandRecord::Adjustment { effect_blob_index } => {
                    if index == 0 || scene_open || layer_id.is_some() {
                        return Err(IrError::InvalidRootScene("overlapping effect".to_owned()));
                    }
                    let effect = slices
                        .iter()
                        .find_map(|s| match s {
                            PlanSlice::EffectExecution(e) if e.blob_index == *effect_blob_index => {
                                Some(e)
                            }
                            _ => None,
                        })
                        .ok_or_else(|| IrError::InvalidRootScene("effect reference".to_owned()))?;
                    let is_layer = matches!(command, RootCommandRecord::BeginLayer { .. });
                    if effect.route
                        != if is_layer {
                            EffectExecutionRoute::Layer
                        } else {
                            EffectExecutionRoute::Adjustment
                        }
                    {
                        return Err(IrError::InvalidRootScene("effect route".to_owned()));
                    }
                    if is_layer {
                        layer_id = Some(effect.instance_id.clone());
                    }
                }
                RootCommandRecord::Geometry {
                    draw_index,
                    blend_mode,
                } => {
                    let draw = self
                        .draws
                        .get(*draw_index as usize)
                        .ok_or_else(|| IrError::InvalidRootScene("draw reference".to_owned()))?;
                    Self::validate_draw(scene_open, &layer_id, &draw.instance_id, blend_mode)?;
                }
                RootCommandRecord::Generator {
                    instance_id,
                    blend_mode,
                } => {
                    instance_id.validate()?;
                    Self::validate_draw(scene_open, &layer_id, instance_id, blend_mode)?;
                }
            }
        }
        if scene_open
            || layer_id.is_some()
            || clear_count == 0
            || blob.element_type != ElementType::U8
            || blob.byte_length != clear_count * 40
            || blob.element_count != blob.byte_length
        {
            return Err(IrError::InvalidRootScene(
                "open pass or clear payload".to_owned(),
            ));
        }
        Ok(())
    }

    fn validate_draw(
        scene_open: bool,
        layer_id: &Option<CompositionIdentity>,
        instance_id: &CompositionIdentity,
        blend: &EffectBlendMode,
    ) -> Result<(), IrError> {
        if let Some(layer) = layer_id {
            if layer != instance_id || *blend != EffectBlendMode::Normal {
                return Err(IrError::InvalidRootScene(
                    "isolated draw identity/blend".to_owned(),
                ));
            }
        } else if !scene_open
            || !matches!(
                blend,
                EffectBlendMode::Normal | EffectBlendMode::Add | EffectBlendMode::Screen
            )
        {
            return Err(IrError::InvalidRootScene("draw pass/blend".to_owned()));
        }
        Ok(())
    }

    pub fn validate_payload(&self, bytes: &[u8]) -> Result<(), IrError> {
        if bytes.is_empty() || !bytes.len().is_multiple_of(40) {
            return Err(IrError::InvalidRootScene("clear bytes".to_owned()));
        }
        for (lane, chunk) in bytes.chunks_exact(8).enumerate() {
            let value = f64::from_le_bytes(
                chunk
                    .try_into()
                    .map_err(|_| IrError::ElementCountMismatch)?,
            );
            if !value.is_finite() || (lane % 5 == 4 && !(0.0..=1.0).contains(&value)) {
                return Err(IrError::InvalidRootScene("clear value".to_owned()));
            }
        }
        Ok(())
    }
}

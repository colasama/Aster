use std::collections::BTreeMap;

use aster_render_ir::{
    BufferResourceDescriptor, EffectBlendMode, EffectComposite, ElementType, ResourceHash,
    RootCommandRecord, RootTextureReference,
};

use crate::{
    RenderError, layer_plan::LayerPlan, scene_input::SceneInput, surface_plan::SurfacePlan,
};

pub(crate) struct LayerKey {
    pub hash: ResourceHash,
    pub end: usize,
}

impl LayerKey {
    /// Keys contain evaluated bytes and recursive pixel generations, never playback history.
    pub fn collect(
        frame: &SceneInput,
        generations: &BTreeMap<Vec<u16>, ResourceHash>,
    ) -> Result<BTreeMap<usize, Self>, RenderError> {
        let mut keys = BTreeMap::new();
        for (start, command) in frame.root.commands.iter().enumerate() {
            let RootCommandRecord::BeginLayer { effect_blob_index } = command else {
                continue;
            };
            let plan = frame
                .layers
                .get(effect_blob_index)
                .ok_or_else(|| RenderError::Invalid("cached layer program absent".into()))?;
            if plan.composite == EffectComposite::Replace {
                continue;
            }
            let mut bytes = b"native-layer-output-v2".to_vec();
            bytes.extend(frame.header.render_target.width.to_le_bytes());
            bytes.extend(frame.header.render_target.height.to_le_bytes());
            bytes.extend((frame.lighting.len() as u64).to_le_bytes());
            bytes.extend(&frame.lighting);
            Self::append_program(&mut bytes, plan)?;
            let mut end = None;
            let mut supported = true;
            for (index, command) in frame.root.commands.iter().enumerate().skip(start + 1) {
                match command {
                    RootCommandRecord::FinishLayer => {
                        end = Some(index);
                        break;
                    }
                    RootCommandRecord::Geometry {
                        draw_index,
                        blend_mode,
                    } => {
                        if !Self::append_draw(
                            &mut bytes,
                            frame,
                            *draw_index,
                            blend_mode,
                            generations,
                        )? {
                            supported = false;
                            break;
                        }
                    }
                    _ => {
                        supported = false;
                        break;
                    }
                }
            }
            if supported && let Some(end) = end {
                let hash = Self::hash(&bytes)?;
                keys.insert(start, Self { hash, end });
            }
        }
        Ok(keys)
    }

    pub fn append_program(bytes: &mut Vec<u8>, plan: &LayerPlan) -> Result<(), RenderError> {
        let mut uniforms = plan.uniforms.clone();
        // Only the audited time-independent program may omit its unused clock lane.
        // Grain and unknown revisions retain exact time to prevent stale animated pixels.
        if uniforms.len() == 96
            && (f32::from_le_bytes([uniforms[8], uniforms[9], uniforms[10], uniforms[11]]) * 91.7)
                .is_finite()
            && f32::from_le_bytes(
                uniforms[52..56]
                    .try_into()
                    .map_err(|_| RenderError::Invalid("cache grain lane".into()))?,
            ) == 0.0
            && plan.operations.chunks_exact(64).all(|op| {
                let code = f32::from_le_bytes([op[0], op[1], op[2], op[3]]);
                !crate::program_time::ProgramTime::depends(code)
            })
        {
            uniforms[8..12].fill(0);
        }
        bytes.extend(plan.pyramids.blur.to_le_bytes());
        bytes.extend(plan.pyramids.glow.to_le_bytes());
        bytes.extend(plan.glow_threshold.to_le_bytes());
        for part in [
            uniforms.as_slice(),
            plan.operations.as_slice(),
            plan.lut.as_ref().map_or(&[], |hash| hash.0.as_bytes()),
        ] {
            bytes.extend((part.len() as u64).to_le_bytes());
            bytes.extend(part);
        }
        Ok(())
    }

    pub fn append_draw(
        bytes: &mut Vec<u8>,
        frame: &SceneInput,
        draw_index: u32,
        blend_mode: &EffectBlendMode,
        generations: &BTreeMap<Vec<u16>, ResourceHash>,
    ) -> Result<bool, RenderError> {
        let draw = frame
            .root
            .draws
            .get(draw_index as usize)
            .ok_or_else(|| RenderError::Invalid("cached draw index".into()))?;
        if draw.material_blob_index.is_some() {
            return Ok(false);
        }
        bytes.push(crate::SuppliedFrame::blend_index(blend_mode)?);
        bytes.extend(draw.vertex_count.to_le_bytes());
        let first = draw.first_vertex as usize * 160;
        let last = first + draw.vertex_count as usize * 160;
        bytes.extend(
            frame
                .vertices
                .get(first..last)
                .ok_or_else(|| RenderError::Invalid("cached vertex range".into()))?,
        );
        match &draw.texture {
            RootTextureReference::None => bytes.push(0),
            RootTextureReference::Media { hash } => {
                let image = frame
                    .images
                    .get(hash)
                    .ok_or_else(|| RenderError::Invalid("cached image generation absent".into()))?;
                bytes.push(1);
                bytes.extend(image.frame.0.as_bytes());
                bytes.extend(image.pixels.0.as_bytes());
                bytes.extend(image.width.to_le_bytes());
                bytes.extend(image.height.to_le_bytes());
                bytes.extend(image.format.bytes_per_pixel().to_le_bytes());
            }
            RootTextureReference::Surface { instance_id } => {
                let Some(hash) = generations.get(&SurfacePlan::key(instance_id)) else {
                    return Ok(false);
                };
                bytes.push(2);
                bytes.extend(hash.0.as_bytes());
            }
            _ => return Ok(false),
        }
        Ok(true)
    }

    pub fn hash(bytes: &[u8]) -> Result<ResourceHash, RenderError> {
        let length = u32::try_from(bytes.len())
            .map_err(|_| RenderError::Invalid("input key exceeds buffer limit".into()))?;
        Ok(ResourceHash::for_buffer(
            &BufferResourceDescriptor {
                element_type: ElementType::U8,
                element_count: length,
                byte_length: length,
            },
            bytes,
        )?)
    }
}

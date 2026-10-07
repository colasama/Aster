use std::collections::BTreeMap;

use aster_render_ir::{
    BufferResourceDescriptor, EffectComposite, ElementType, ResourceHash, RootCommandRecord,
    RootTextureReference,
};

use crate::{RenderError, scene_input::SceneInput};

pub(crate) struct LayerKey {
    pub hash: ResourceHash,
    pub end: usize,
}

impl LayerKey {
    /// Keys contain evaluated bytes, never instance names or playback history. Surface inputs
    /// remain uncached until their complete recursive pixel generation is represented here.
    pub fn collect(frame: &SceneInput) -> Result<BTreeMap<usize, Self>, RenderError> {
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
            let mut uniforms = plan.uniforms.clone();
            // These six audited operations never consume time. Every other opcode retains the
            // exact time lane, so unknown time dependencies cause misses instead of stale pixels.
            if uniforms.len() == 96
                && (f32::from_le_bytes([uniforms[8], uniforms[9], uniforms[10], uniforms[11]])
                    * 91.7)
                    .is_finite()
                && f32::from_le_bytes(
                    uniforms[52..56]
                        .try_into()
                        .map_err(|_| RenderError::Invalid("cache grain lane".into()))?,
                ) == 0.0
                && plan.operations.chunks_exact(64).all(|op| {
                    let code = f32::from_le_bytes([op[0], op[1], op[2], op[3]]);
                    matches!(code, 1.0 | 2.0 | 3.0 | 4.0 | 5.0 | 6.0)
                })
            {
                uniforms[8..12].fill(0);
            }
            let mut bytes = b"native-layer-output-v1".to_vec();
            bytes.extend(frame.header.render_target.width.to_le_bytes());
            bytes.extend(frame.header.render_target.height.to_le_bytes());
            bytes.extend(plan.pyramids.blur.to_le_bytes());
            bytes.extend(plan.pyramids.glow.to_le_bytes());
            bytes.extend(plan.glow_threshold.to_le_bytes());
            for part in [
                frame.lighting.as_slice(),
                &uniforms,
                &plan.operations,
                plan.lut.as_ref().map_or(&[], |hash| hash.0.as_bytes()),
            ] {
                bytes.extend((part.len() as u64).to_le_bytes());
                bytes.extend(part);
            }
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
                        let draw = frame
                            .root
                            .draws
                            .get(*draw_index as usize)
                            .ok_or_else(|| RenderError::Invalid("cached draw index".into()))?;
                        bytes.push(crate::SuppliedFrame::blend_index(blend_mode)?);
                        bytes.extend(draw.vertex_count.to_le_bytes());
                        let first = draw.first_vertex as usize * 160;
                        let last = first + draw.vertex_count as usize * 160;
                        bytes.extend(
                            frame.vertices.get(first..last).ok_or_else(|| {
                                RenderError::Invalid("cached vertex range".into())
                            })?,
                        );
                        match &draw.texture {
                            RootTextureReference::None => bytes.push(0),
                            RootTextureReference::Media { hash } => {
                                let image = frame.images.get(hash).ok_or_else(|| {
                                    RenderError::Invalid("cached image generation absent".into())
                                })?;
                                bytes.push(1);
                                bytes.extend(image.frame.0.as_bytes());
                                bytes.extend(image.pixels.0.as_bytes());
                                bytes.extend(image.width.to_le_bytes());
                                bytes.extend(image.height.to_le_bytes());
                                bytes.extend(image.format.bytes_per_pixel().to_le_bytes());
                            }
                            _ => {
                                supported = false;
                                break;
                            }
                        }
                    }
                    _ => {
                        supported = false;
                        break;
                    }
                }
            }
            if supported && let Some(end) = end {
                let length = u32::try_from(bytes.len())
                    .map_err(|_| RenderError::Invalid("layer key exceeds buffer limit".into()))?;
                let hash = ResourceHash::for_buffer(
                    &BufferResourceDescriptor {
                        element_type: ElementType::U8,
                        element_count: length,
                        byte_length: length,
                    },
                    &bytes,
                )?;
                keys.insert(start, Self { hash, end });
            }
        }
        Ok(keys)
    }
}

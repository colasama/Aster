use std::collections::BTreeMap;

use aster_render_ir::{EffectComposite, ResourceHash, RootCommandRecord, RootLoadOp, RootStoreOp};

use crate::{RenderError, layer_key::LayerKey, surface_plan::SurfacePlan};

pub(crate) struct SurfaceGenerations;

impl SurfaceGenerations {
    /// Child-first fingerprints describe the exact supplied scene execution. Histories without
    /// an initial clear and unknown commands stay uncached, including every dependent parent.
    pub fn collect(plan: &SurfacePlan) -> Result<BTreeMap<Vec<u16>, ResourceHash>, RenderError> {
        let mut generations = BTreeMap::new();
        for (index, target) in plan.targets.iter().enumerate() {
            let scene = &target.scene;
            if !matches!(
                scene.root.commands.first(),
                Some(RootCommandRecord::BeginScene {
                    color_load: RootLoadOp::Clear,
                    depth_load: RootLoadOp::Clear,
                    ..
                })
            ) {
                continue;
            }
            let mut bytes = b"native-scene-pixels-v1".to_vec();
            bytes.extend(target.size.width.to_le_bytes());
            bytes.extend(target.size.height.to_le_bytes());
            bytes.extend((scene.lighting.len() as u64).to_le_bytes());
            bytes.extend(&scene.lighting);
            let mut supported = true;
            for command in &scene.root.commands {
                match command {
                    RootCommandRecord::BeginScene {
                        color_load,
                        color_store,
                        depth_load,
                        depth_store,
                        clear_index,
                        ..
                    } => {
                        if *color_store != RootStoreOp::Store || *depth_store != RootStoreOp::Store
                        {
                            supported = false;
                            break;
                        }
                        bytes.extend([
                            1,
                            u8::from(*color_load == RootLoadOp::Clear),
                            u8::from(*depth_load == RootLoadOp::Clear),
                        ]);
                        let clear = scene.clears.get(*clear_index as usize).ok_or_else(|| {
                            RenderError::Invalid("surface generation clear absent".into())
                        })?;
                        for value in clear {
                            bytes.extend(value.to_le_bytes());
                        }
                    }
                    RootCommandRecord::EndScene => bytes.push(2),
                    RootCommandRecord::BeginLayer { effect_blob_index }
                    | RootCommandRecord::Adjustment { effect_blob_index } => {
                        bytes.push(if matches!(command, RootCommandRecord::Adjustment { .. }) {
                            5
                        } else {
                            3
                        });
                        let layer = scene.layers.get(effect_blob_index).ok_or_else(|| {
                            RenderError::Invalid("surface generation effect absent".into())
                        })?;
                        bytes.push(layer.blend);
                        bytes.push(match layer.composite {
                            EffectComposite::None => 0,
                            EffectComposite::Fixed => 1,
                            EffectComposite::Backdrop => 2,
                            EffectComposite::Replace => 3,
                        });
                        LayerKey::append_program(&mut bytes, layer)?;
                    }
                    RootCommandRecord::FinishLayer => bytes.push(4),
                    RootCommandRecord::Geometry {
                        draw_index,
                        blend_mode,
                    } => {
                        bytes.push(6);
                        if !LayerKey::append_draw(
                            &mut bytes,
                            scene,
                            *draw_index,
                            blend_mode,
                            &generations,
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
            if supported {
                let hash = LayerKey::hash(&bytes)?;
                for (alias, target_index) in &plan.bindings {
                    if *target_index == index {
                        generations.insert(alias.clone(), hash.clone());
                    }
                }
            }
        }
        Ok(generations)
    }
}

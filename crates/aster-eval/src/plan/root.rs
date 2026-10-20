use super::{EffectExecutionPlan, NativePlan};
use crate::EvaluationError;
use aster_render_ir::{
    BlobDescriptor, CompositionIdentity, ContractLevel, DecodeLimits, EffectBlendMode,
    EffectExecutionRoute, ElementType, FrameHeaderSlice, FramePlanSliceV1, PlanKind, PlanSlice,
    RootCommandRecord, RootDrawRecord, RootLoadOp, RootPassGroup, RootSceneCommandsSlice,
    RootStoreOp, RootTextureReference,
};
use std::collections::{BTreeMap, BTreeSet};

pub enum RootItemKind {
    Geometry(u32),
    Generator,
    Adjustment,
}
pub struct RootStackItem {
    pub instance_id: String,
    pub kind: RootItemKind,
    pub clear_depth: bool,
}

pub struct RootSceneInput {
    pub header: FrameHeaderSlice,
    pub background: [f64; 4],
    pub draws: Vec<RootDrawRecord>,
    pub items: Vec<RootStackItem>,
    pub effects: BTreeMap<String, EffectExecutionPlan>,
    pub generators: BTreeSet<String>,
    pub materials: BTreeMap<String, NativePlan>,
}

struct RootAssembler {
    commands: Vec<RootCommandRecord>,
    clears: Vec<u8>,
    dependencies: Vec<NativePlan>,
    scene_open: bool,
    clear_depth: bool,
}

impl RootSceneInput {
    pub fn build(mut self) -> Result<NativePlan, EvaluationError> {
        if self.items.len() > 65_536 || self.draws.len() > 65_536 {
            return Err(EvaluationError::InvalidScene(
                "root item budget exceeded".into(),
            ));
        }
        let mut state = RootAssembler {
            commands: Vec::new(),
            clears: Vec::new(),
            dependencies: Vec::new(),
            scene_open: false,
            clear_depth: true,
        };
        for draw in &mut self.draws {
            let CompositionIdentity::Unicode(id) = &draw.instance_id else {
                return Err(EvaluationError::InvalidScene(
                    "native draw identity must be Unicode".into(),
                ));
            };
            draw.material_blob_index = if let Some(material) = self.materials.get(id) {
                Some(state.append(material, &self.header)?)
            } else {
                None
            };
        }
        state.begin(
            RootPassGroup::Composition,
            RootLoadOp::Clear,
            self.background,
        );
        let mut drawn = BTreeSet::new();
        for item in self.items {
            if item.clear_depth {
                state.end();
                state.clear_depth = true;
            }
            if matches!(item.kind, RootItemKind::Generator)
                && (!self.generators.contains(&item.instance_id)
                    || drawn.contains(&item.instance_id))
            {
                continue;
            }
            let effect = self.effects.get(&item.instance_id).ok_or_else(|| {
                EvaluationError::InvalidScene(format!(
                    "missing effect execution: {}",
                    item.instance_id
                ))
            })?;
            if matches!(item.kind, RootItemKind::Adjustment) {
                if effect.route == EffectExecutionRoute::Skip {
                    continue;
                }
                state.end();
                let effect_blob_index = state.append(&effect.plan, &self.header)?;
                state
                    .commands
                    .push(RootCommandRecord::Adjustment { effect_blob_index });
                continue;
            }
            let isolated = effect.route == EffectExecutionRoute::Layer;
            if isolated {
                state.end();
                let effect_blob_index = state.append(&effect.plan, &self.header)?;
                state
                    .commands
                    .push(RootCommandRecord::BeginLayer { effect_blob_index });
            } else if !state.scene_open {
                state.begin(
                    if matches!(item.kind, RootItemKind::Generator) {
                        RootPassGroup::Generator
                    } else {
                        RootPassGroup::Geometry
                    },
                    RootLoadOp::Load,
                    [0.; 4],
                );
            }
            let blend_mode = if isolated {
                EffectBlendMode::Normal
            } else {
                effect.blend_mode.clone()
            };
            match item.kind {
                RootItemKind::Generator => {
                    drawn.insert(item.instance_id.clone());
                    state.commands.push(RootCommandRecord::Generator {
                        instance_id: CompositionIdentity::Unicode(item.instance_id),
                        blend_mode,
                    });
                }
                RootItemKind::Geometry(draw_index) => {
                    state.commands.push(RootCommandRecord::Geometry {
                        draw_index,
                        blend_mode,
                    })
                }
                RootItemKind::Adjustment => {
                    unreachable!("adjustments handled before draw dispatch")
                }
            }
            if isolated {
                state.commands.push(RootCommandRecord::FinishLayer);
            }
        }
        state.end();
        state.finish(self.header, self.draws)
    }
}

impl RootAssembler {
    fn begin(&mut self, group: RootPassGroup, color_load: RootLoadOp, background: [f64; 4]) {
        let clear_index = (self.clears.len() / 40) as u32;
        self.clears.extend(
            background
                .into_iter()
                .chain([1.0])
                .flat_map(f64::to_le_bytes),
        );
        self.commands.push(RootCommandRecord::BeginScene {
            group,
            color_load,
            color_store: RootStoreOp::Store,
            depth_load: if self.clear_depth {
                RootLoadOp::Clear
            } else {
                RootLoadOp::Load
            },
            depth_store: RootStoreOp::Store,
            clear_index,
        });
        self.scene_open = true;
        self.clear_depth = false;
    }

    fn end(&mut self) {
        if self.scene_open {
            self.commands.push(RootCommandRecord::EndScene);
        }
        self.scene_open = false;
    }

    fn append(
        &mut self,
        dependency: &NativePlan,
        header: &FrameHeaderSlice,
    ) -> Result<u32, EvaluationError> {
        if self.dependencies.len() + 1 >= DecodeLimits::default().max_blobs
            || dependency.metadata.header != *header
            || dependency.blobs.len() != 1
            || dependency.metadata.blobs.len() != 1
            || dependency.metadata.slices.len() != 1
            || !matches!(
                dependency.metadata.slices[0],
                PlanSlice::EffectExecution(_) | PlanSlice::MaterialBinding(_)
            )
        {
            return Err(EvaluationError::InvalidScene(
                "incompatible root dependency".into(),
            ));
        }
        self.dependencies.push(dependency.clone());
        u32::try_from(self.dependencies.len()).map_err(|_| {
            EvaluationError::InvalidScene("root dependency count exceeds wire range".into())
        })
    }

    fn finish(
        self,
        header: FrameHeaderSlice,
        draws: Vec<RootDrawRecord>,
    ) -> Result<NativePlan, EvaluationError> {
        let mut resources = BTreeSet::new();
        for draw in &draws {
            if let RootTextureReference::Media { hash } = &draw.texture {
                resources.insert(hash.clone());
            }
        }
        let length = self.clears.len() as u32;
        let mut metadata = FramePlanSliceV1 {
            kind: PlanKind::FramePlanSlice,
            plan_version: 1,
            contract_level: ContractLevel::RootSceneCommandsSliceV1,
            renderer_plan_complete: false,
            header,
            resources: Vec::new(),
            blobs: vec![BlobDescriptor {
                byte_offset: 0,
                byte_length: length,
                element_type: ElementType::U8,
                element_count: length,
            }],
            slices: vec![PlanSlice::RootSceneCommands(RootSceneCommandsSlice {
                blob_index: 0,
                draws,
                commands: self.commands,
            })],
        };
        let mut offset = u64::from(length).div_ceil(16) * 16;
        let mut blobs = vec![self.clears];
        for mut dependency in self.dependencies {
            let mut descriptor = dependency.metadata.blobs.remove(0);
            descriptor.byte_offset = u32::try_from(offset).map_err(|_| {
                EvaluationError::InvalidScene("root dependency bytes exceed wire range".into())
            })?;
            offset = (offset + u64::from(descriptor.byte_length)).div_ceil(16) * 16;
            let mut slice = dependency.metadata.slices.remove(0);
            match &mut slice {
                PlanSlice::EffectExecution(effect) => effect.blob_index = blobs.len() as u32,
                PlanSlice::MaterialBinding(material) => material.blob_index = blobs.len() as u32,
                _ => {
                    return Err(EvaluationError::InvalidScene(
                        "invalid root dependency kind".into(),
                    ));
                }
            }
            metadata.blobs.push(descriptor);
            metadata.slices.push(slice);
            resources.extend(dependency.metadata.resources);
            blobs.push(dependency.blobs.remove(0));
        }
        metadata.resources = resources.into_iter().collect();
        metadata
            .validate(&DecodeLimits::default())
            .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        for (index, bytes) in blobs.iter().enumerate() {
            metadata
                .validate_blob(index, bytes)
                .map_err(|e| EvaluationError::InvalidScene(e.to_string()))?;
        }
        Ok(NativePlan { metadata, blobs })
    }
}

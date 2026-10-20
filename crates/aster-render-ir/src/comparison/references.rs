use crate::{
    ContractLevel, FramePlanSliceV1, PlanSlice, PrecompositionEffectRecord,
    PrecompositionGeneratorRecord, ResourceHash,
};

pub(super) struct PlanReferences;

impl PlanReferences {
    /// Only declared nested-plan fields can receive semantic hash substitution.
    pub fn visit(
        metadata: &mut FramePlanSliceV1,
        mut visit: impl FnMut(String, &mut ResourceHash, ContractLevel),
    ) {
        for (i, slice) in metadata.slices.iter_mut().enumerate() {
            let path = format!("/slices/{i}");
            match slice {
                PlanSlice::FrameBundle(b) => {
                    for (name, hash, contract) in [
                        ("scene", &mut b.scene, ContractLevel::SceneBuffersSliceV1),
                        ("root", &mut b.root, ContractLevel::RootSceneCommandsSliceV1),
                        ("post", &mut b.post, ContractLevel::PostUniformsSliceV1),
                        (
                            "motion",
                            &mut b.motion,
                            ContractLevel::MotionReconstructionSliceV1,
                        ),
                        ("output", &mut b.output, ContractLevel::FinalOutputSliceV1),
                    ] {
                        visit(format!("{path}/{name}"), hash, contract);
                    }
                    for (name, hash, contract) in [
                        (
                            "auxiliary",
                            &mut b.auxiliary,
                            ContractLevel::AuxiliarySliceV1,
                        ),
                        ("effect", &mut b.effect, ContractLevel::PostEffectSliceV1),
                        (
                            "precompositions",
                            &mut b.precompositions,
                            ContractLevel::PrecompositionBundleSliceV1,
                        ),
                    ] {
                        if let Some(hash) = hash {
                            visit(format!("{path}/{name}"), hash, contract);
                        }
                    }
                    for (j, hash) in b.temporal.iter_mut().enumerate() {
                        visit(
                            format!("{path}/temporal/{j}"),
                            hash,
                            ContractLevel::TemporalTextPassesSliceV1,
                        );
                    }
                    Self::programs(&path, &mut b.effects, &mut b.generators, &mut visit);
                }
                PlanSlice::PrecompositionBundle(b) => {
                    visit(
                        format!("{path}/graph"),
                        &mut b.graph,
                        ContractLevel::PrecompositionGraphSliceV1,
                    );
                    for (j, scene) in b.scenes.iter_mut().enumerate() {
                        let path = format!("{path}/scenes/{j}");
                        visit(
                            format!("{path}/scene"),
                            &mut scene.scene,
                            ContractLevel::SceneBuffersSliceV1,
                        );
                        visit(
                            format!("{path}/commands"),
                            &mut scene.commands,
                            ContractLevel::RootSceneCommandsSliceV1,
                        );
                        Self::programs(
                            &path,
                            &mut scene.effects,
                            &mut scene.generators,
                            &mut visit,
                        );
                    }
                }
                _ => {}
            }
        }
    }

    fn programs(
        path: &str,
        effects: &mut [PrecompositionEffectRecord],
        generators: &mut [PrecompositionGeneratorRecord],
        visit: &mut impl FnMut(String, &mut ResourceHash, ContractLevel),
    ) {
        for (i, effect) in effects.iter_mut().enumerate() {
            let path = format!("{path}/effects/{i}");
            match effect {
                PrecompositionEffectRecord::Ready {
                    execution, plan, ..
                } => {
                    visit(
                        format!("{path}/execution"),
                        execution,
                        ContractLevel::EffectExecutionSliceV1,
                    );
                    visit(
                        format!("{path}/plan"),
                        plan,
                        ContractLevel::LayerEffectsSliceV1,
                    );
                }
                PrecompositionEffectRecord::Direct { execution, .. }
                | PrecompositionEffectRecord::Skipped { execution, .. }
                | PrecompositionEffectRecord::Failed { execution, .. } => visit(
                    format!("{path}/execution"),
                    execution,
                    ContractLevel::EffectExecutionSliceV1,
                ),
            }
        }
        for (i, generator) in generators.iter_mut().enumerate() {
            visit(
                format!("{path}/generators/{i}/plan"),
                &mut generator.plan,
                ContractLevel::SceneGeneratorSliceV1,
            );
        }
    }
}

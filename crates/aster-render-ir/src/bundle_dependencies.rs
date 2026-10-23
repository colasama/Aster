use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use crate::{
    DecodeLimits, FramePlanSliceV1, IrError, OwnedFpln, PlanSlice, PrecompositionEffectRecord,
    PrecompositionGeneratorRecord, ResourceHash, ResourceRegistry,
};

#[derive(Default)]
pub struct BundleDependencies {
    pending: Vec<ResourceHash>,
    checked: BTreeMap<ResourceHash, ()>,
    roundtrip: bool,
}

impl BundleDependencies {
    /// Diagnostic audits additionally reconstruct every nested container byte for byte.
    pub fn with_roundtrip(mut self) -> Self {
        self.roundtrip = true;
        self
    }

    fn programs(
        &mut self,
        effects: &[PrecompositionEffectRecord],
        generators: &[PrecompositionGeneratorRecord],
    ) {
        for effect in effects {
            match effect {
                PrecompositionEffectRecord::Ready {
                    execution, plan, ..
                } => {
                    self.pending.extend([execution.clone(), plan.clone()]);
                }
                PrecompositionEffectRecord::Direct { execution, .. }
                | PrecompositionEffectRecord::Skipped { execution, .. }
                | PrecompositionEffectRecord::Failed { execution, .. } => {
                    self.pending.push(execution.clone());
                }
            }
        }
        self.pending
            .extend(generators.iter().map(|g| g.plan.clone()));
    }

    fn extend(&mut self, metadata: &FramePlanSliceV1) {
        for slice in &metadata.slices {
            match slice {
                PlanSlice::FrameBundle(bundle) => {
                    self.pending.extend([
                        bundle.scene.clone(),
                        bundle.root.clone(),
                        bundle.post.clone(),
                        bundle.motion.clone(),
                        bundle.output.clone(),
                    ]);
                    self.pending.extend(
                        [
                            bundle.auxiliary.clone(),
                            bundle.effect.clone(),
                            bundle.precompositions.clone(),
                        ]
                        .into_iter()
                        .flatten(),
                    );
                    self.pending.extend(bundle.temporal.clone());
                    self.programs(&bundle.effects, &bundle.generators);
                }
                PlanSlice::PrecompositionBundle(bundle) => {
                    self.pending.push(bundle.graph.clone());
                    for scene in &bundle.scenes {
                        self.pending
                            .extend([scene.scene.clone(), scene.commands.clone()]);
                        self.programs(&scene.effects, &scene.generators);
                    }
                }
                _ => {}
            }
        }
    }

    /// Only typed plan references are decoded; shader or pixel bytes may start with any magic.
    pub fn validate(
        self,
        root: &FramePlanSliceV1,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<usize, IrError> {
        self.validate_with(root, registry, limits, |_, _, _| {})
    }

    /// Visitors receive individually validated plans; discard results if the closure fails.
    pub fn validate_with(
        mut self,
        root: &FramePlanSliceV1,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
        mut visit: impl FnMut(ResourceHash, Arc<OwnedFpln>, usize),
    ) -> Result<usize, IrError> {
        let resources = root.resources.iter().collect::<BTreeSet<_>>();
        self.extend(root);
        while let Some(hash) = self.pending.pop() {
            if self.checked.insert(hash.clone(), ()).is_some() {
                continue;
            }
            let bytes = registry.resolve(&hash)?;
            let nested = registry.resolve_plan(&hash, limits)?;
            // Admission or decode enforces canonical JSON, contiguous ranges, zero padding and
            // every typed blob invariant. Reconstruction is only needed by explicit audits.
            if (self.roundtrip && nested.reencode(limits)? != bytes)
                || nested
                    .metadata
                    .resources
                    .iter()
                    .any(|reference| !resources.contains(reference))
            {
                return Err(IrError::InvalidResource(
                    "nested plan differs or lacks resources".to_owned(),
                ));
            }
            self.extend(&nested.metadata);
            visit(hash, nested, bytes.len());
        }
        Ok(self.checked.len())
    }
}

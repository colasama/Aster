use std::{collections::BTreeMap, sync::Arc};

use aster_render_ir::{
    BundleDependencies, DecodeLimits, FramePlanSliceV1, IrError, OwnedFpln, ResourceHash,
    ResourceRegistry,
};

/// Immutable decoded plans retained only while assembling one supplied frame.
pub(crate) struct FramePlans {
    plans: BTreeMap<ResourceHash, Arc<OwnedFpln>>,
    limits: DecodeLimits,
}

impl FramePlans {
    pub(crate) fn new(
        root: &FramePlanSliceV1,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<Self, IrError> {
        let mut plans = BTreeMap::new();
        let mut retained_bytes = 0_usize;
        BundleDependencies::default().validate_with(
            root,
            registry,
            limits,
            |hash, plan, bytes| {
                if bytes <= limits.max_container_bytes.saturating_sub(retained_bytes) {
                    retained_bytes += bytes;
                    plans.insert(hash, plan);
                }
            },
        )?;
        Ok(Self {
            plans,
            limits: limits.clone(),
        })
    }

    /// Callers keep the registry immutable for this frame's complete assembly.
    pub(crate) fn resolve(
        &self,
        hash: &ResourceHash,
        registry: &ResourceRegistry,
    ) -> Result<Arc<OwnedFpln>, IrError> {
        if let Some(plan) = self.plans.get(hash) {
            return Ok(Arc::clone(plan));
        }
        // Retention pressure does not relax validation or reject otherwise valid frames.
        registry.resolve_plan(hash, &self.limits)
    }
}

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use aster_render_ir::{
    ContractLevel, DecodeLimits, ElementType, FplnCodec, OwnedFpln, PlanSlice,
    PrecompositionGeneratorExecution, PrecompositionGeneratorRecord, ResourceDescriptor,
    ResourceHash, ResourceRegistry, RootCommandRecord, SceneGeneratorSlice,
};

use crate::{RenderError, layer_key::LayerKey, surface_plan::SurfacePlan};

pub(crate) struct GeneratorInput {
    pub invocation: SceneGeneratorSlice,
    pub payload: Vec<u8>,
    pub audio: Option<Arc<[u8]>>,
    pub shaders: BTreeMap<ResourceHash, Arc<str>>,
    pub program_key: ResourceHash,
}

impl GeneratorInput {
    pub fn collect(
        records: &[PrecompositionGeneratorRecord],
        root: &OwnedFpln,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<BTreeMap<Vec<u16>, Self>, RenderError> {
        let mut result = BTreeMap::new();
        let mut sources = BTreeMap::<ResourceHash, Arc<str>>::new();
        let mut audio: Option<Arc<[u8]>> = None;
        let mut identities = BTreeSet::new();
        for record in records {
            let plan = FplnCodec::decode(registry.resolve(&record.plan)?.to_vec(), limits)?;
            let Some(PlanSlice::SceneGenerator(invocation)) = plan.metadata.slices.first() else {
                return Err(RenderError::Invalid("generator invocation absent".into()));
            };
            let mut header = plan.metadata.header.clone();
            if root.metadata.header.snapshot_scope == "precomposition-scenes"
                && header.snapshot_scope == "precomposition-generators"
            {
                header.snapshot_scope = root.metadata.header.snapshot_scope.clone();
            }
            if plan.metadata.contract_level != ContractLevel::SceneGeneratorSliceV1
                || header != root.metadata.header
                || invocation.instance_id != record.instance_id
            {
                return Err(RenderError::Invalid(
                    "generator identity or realization differs".into(),
                ));
            }
            if !identities.insert(SurfacePlan::key(&record.instance_id)) {
                return Err(RenderError::Invalid("duplicate generator instance".into()));
            }
            let ready = match record.execution {
                PrecompositionGeneratorExecution::Unavailable
                    if root.metadata.header.snapshot_scope == "precomposition-scenes" =>
                {
                    false
                }
                PrecompositionGeneratorExecution::Ready {
                    capacity,
                    effective_count,
                } if capacity == invocation.capacity
                    && effective_count == invocation.effective_count =>
                {
                    true
                }
                _ => return Err(RenderError::Invalid("generator realization differs".into())),
            };
            let mut shaders = BTreeMap::new();
            let mut total = 0;
            for hash in &plan.metadata.resources {
                let ResourceDescriptor::Buffer(descriptor) = registry.descriptor(hash)? else {
                    return Err(RenderError::Invalid(
                        "generator shader buffer required".into(),
                    ));
                };
                let bytes = registry.resolve(hash)?;
                total += bytes.len();
                if descriptor.element_type != ElementType::U8
                    || bytes.is_empty()
                    || bytes.len() > 4 * 1024 * 1024
                    || total > 16 * 1024 * 1024
                {
                    return Err(RenderError::Invalid(
                        "generator shader byte budget exceeded".into(),
                    ));
                }
                if !sources.contains_key(hash) {
                    let source = std::str::from_utf8(bytes).map_err(|_| {
                        RenderError::Invalid("generator shader is not UTF-8".into())
                    })?;
                    sources.insert(hash.clone(), Arc::from(source));
                }
                let source = sources
                    .get(hash)
                    .ok_or_else(|| RenderError::Invalid("generator shader cache absent".into()))?;
                shaders.insert(hash.clone(), Arc::clone(source));
            }
            if !ready {
                continue;
            }
            let program = serde_json::to_vec(&invocation.program)
                .map_err(|error| RenderError::Invalid(error.to_string()))?;
            let payload = plan.blob(invocation.blob_index as usize)?.to_vec();
            if invocation.has_audio {
                if audio
                    .as_deref()
                    .is_some_and(|audio| audio != &payload[2272..])
                {
                    return Err(RenderError::Invalid(
                        "generator audio differs within frame".into(),
                    ));
                }
                if audio.is_none() {
                    audio = Some(Arc::from(&payload[2272..]));
                }
            }
            let value = Self {
                audio: None,
                invocation: invocation.clone(),
                payload,
                shaders,
                program_key: LayerKey::hash(&program)?,
            };
            if result
                .insert(SurfacePlan::key(&record.instance_id), value)
                .is_some()
            {
                return Err(RenderError::Invalid("duplicate generator instance".into()));
            }
        }
        let Some(PlanSlice::RootSceneCommands(commands)) = root.metadata.slices.first() else {
            return Err(RenderError::Invalid(
                "generator root commands absent".into(),
            ));
        };
        let requested = commands
            .commands
            .iter()
            .filter_map(|command| match command {
                RootCommandRecord::Generator { instance_id, .. } => {
                    Some(SurfacePlan::key(instance_id))
                }
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        if requested != result.keys().cloned().collect() {
            return Err(RenderError::Invalid(
                "generator command closure differs".into(),
            ));
        }
        for input in result.values_mut() {
            input.audio = audio.clone();
        }
        Ok(result)
    }

    pub fn required_bytes(&self) -> u64 {
        u64::from(self.invocation.capacity)
            * u64::from(self.invocation.program.graph.instance_stride)
            + 208
            + 2048
            + 16
    }

    /// Child compositions share the root-time analysis, even when their local times differ.
    pub fn shared_audio(
        inputs: impl Iterator<Item = Option<Arc<[u8]>>>,
    ) -> Result<Option<Arc<[u8]>>, RenderError> {
        let mut shared: Option<Arc<[u8]>> = None;
        for audio in inputs.flatten() {
            if shared.as_deref().is_some_and(|old| old != audio.as_ref()) {
                return Err(RenderError::Invalid(
                    "generator audio differs within root frame".into(),
                ));
            }
            if shared.is_none() {
                shared = Some(audio);
            }
        }
        Ok(shared)
    }
}

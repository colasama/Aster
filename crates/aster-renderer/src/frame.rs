use aster_render_ir::{
    BundleDependencies, ContractLevel, DecodeLimits, EffectBlendMode, FinalBeautySource,
    FinalOutputRoute, FplnCodec, FrameHeaderSlice, MotionReconstructionStatus, OwnedFpln,
    PlanSlice, ResourceRegistry, RootCommandRecord, RootSceneCommandsSlice, RootTextureReference,
};

use crate::RenderError;

/// Validated, owned execution inputs. No project evaluation or filesystem access occurs here.
pub struct SuppliedFrame {
    pub(crate) header: FrameHeaderSlice,
    pub(crate) lighting: Vec<u8>,
    pub(crate) vertices: Vec<u8>,
    pub(crate) root: RootSceneCommandsSlice,
    pub(crate) clears: Vec<[f64; 5]>,
    pub(crate) post: Vec<u8>,
    pub(crate) output_clear: wgpu::Color,
    pub(crate) layers: std::collections::BTreeMap<u32, crate::layer_plan::LayerPlan>,
}

impl SuppliedFrame {
    pub fn new(
        plan: OwnedFpln,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
    ) -> Result<Self, RenderError> {
        let Some(PlanSlice::FrameBundle(bundle)) = plan.metadata.slices.first() else {
            return Err(RenderError::Invalid("complete root bundle required".into()));
        };
        for hash in &plan.metadata.resources {
            registry.resolve(hash)?;
        }
        BundleDependencies::default().validate(&plan.metadata, registry, limits)?;
        if bundle.auxiliary.is_some()
            || bundle.effect.is_some()
            || bundle.precompositions.is_some()
            || !bundle.temporal.is_empty()
            || !bundle.generators.is_empty()
        {
            return Err(RenderError::Unsupported(
                "effect, auxiliary, temporal, generator or precomposition pass".into(),
            ));
        }
        let stage =
            |hash: &aster_render_ir::ResourceHash, contract| -> Result<OwnedFpln, RenderError> {
                let decoded = FplnCodec::decode(registry.resolve(hash)?.to_vec(), limits)?;
                if decoded.metadata.contract_level != contract
                    || decoded.metadata.header != plan.metadata.header
                {
                    return Err(RenderError::Invalid(
                        "stage contract or frame identity mismatch".into(),
                    ));
                }
                Ok(decoded)
            };
        let scene = stage(&bundle.scene, ContractLevel::SceneBuffersSliceV1)?;
        let root = stage(&bundle.root, ContractLevel::RootSceneCommandsSliceV1)?;
        let layers = crate::layer_plan::LayerPlan::collect(bundle, &root, registry, limits)?;
        let post = stage(&bundle.post, ContractLevel::PostUniformsSliceV1)?;
        if post.blob(0)?[64..80]
            .chunks_exact(4)
            .any(|lane| f32::from_le_bytes([lane[0], lane[1], lane[2], lane[3]]) != 0.0)
        {
            return Err(RenderError::Unsupported(
                "root operation, linear-output or pyramid controls".into(),
            ));
        }
        let motion = stage(&bundle.motion, ContractLevel::MotionReconstructionSliceV1)?;
        let output = stage(&bundle.output, ContractLevel::FinalOutputSliceV1)?;
        if !matches!(motion.metadata.slices.first(), Some(PlanSlice::MotionReconstruction(value)) if value.status == MotionReconstructionStatus::Skipped)
            || !matches!(output.metadata.slices.first(), Some(PlanSlice::FinalOutput(value)) if value.route == (FinalOutputRoute::Beauty { source: FinalBeautySource::Scene }))
        {
            return Err(RenderError::Unsupported(
                "motion or diagnostic output".into(),
            ));
        }
        let Some(PlanSlice::SceneBuffers(scene_slice)) = scene.metadata.slices.first() else {
            return Err(RenderError::Invalid("scene buffers required".into()));
        };
        if !scene_slice.media_bindings.is_empty()
            || (scene_slice.shadows_enabled
                && scene_slice.draws.iter().any(|draw| draw.casts_shadow))
        {
            return Err(RenderError::Unsupported("media or shadow draws".into()));
        }
        let Some(PlanSlice::RootSceneCommands(commands)) = root.metadata.slices.first() else {
            return Err(RenderError::Invalid("root commands required".into()));
        };
        for draw in &commands.draws {
            if draw.texture != RootTextureReference::None || draw.material_blob_index.is_some() {
                return Err(RenderError::Unsupported("texture or material draw".into()));
            }
            if draw
                .first_vertex
                .checked_add(draw.vertex_count)
                .is_none_or(|end| end > scene_slice.vertex_count)
            {
                return Err(RenderError::Invalid(
                    "draw exceeds supplied vertices".into(),
                ));
            }
        }
        for command in &commands.commands {
            match command {
                RootCommandRecord::BeginScene { .. } | RootCommandRecord::EndScene => {}
                RootCommandRecord::Geometry { blend_mode, .. } => {
                    Self::blend_index(blend_mode)?;
                }
                RootCommandRecord::BeginLayer { effect_blob_index }
                    if layers.contains_key(effect_blob_index) => {}
                RootCommandRecord::FinishLayer => {}
                _ => {
                    return Err(RenderError::Unsupported(
                        "layer, adjustment or generator command".into(),
                    ));
                }
            }
        }
        let scene_bytes = scene.blob(scene_slice.blob_index as usize)?;
        let mut clears = Vec::new();
        for bytes in root.blob(commands.blob_index as usize)?.chunks_exact(40) {
            let mut values = [0.0; 5];
            for (value, lane) in values.iter_mut().zip(bytes.chunks_exact(8)) {
                *value = f64::from_le_bytes(
                    lane.try_into()
                        .map_err(|_| RenderError::Invalid("clear lane".into()))?,
                );
            }
            clears.push(values);
        }
        let mut clear = [0.0; 4];
        for (value, bytes) in clear.iter_mut().zip(output.blob(0)?.chunks_exact(4)) {
            *value = f64::from(f32::from_le_bytes(
                bytes
                    .try_into()
                    .map_err(|_| RenderError::Invalid("output clear lane".into()))?,
            ));
        }
        Ok(Self {
            header: plan.metadata.header,
            lighting: scene_bytes[..592].to_vec(),
            vertices: scene_bytes[592..592 + scene_slice.vertex_count as usize * 160].to_vec(),
            root: commands.clone(),
            clears,
            post: post.blob(0)?.to_vec(),
            layers,
            output_clear: wgpu::Color {
                r: clear[0],
                g: clear[1],
                b: clear[2],
                a: clear[3],
            },
        })
    }

    pub(crate) fn blend_index(mode: &EffectBlendMode) -> Result<u8, RenderError> {
        match mode {
            EffectBlendMode::Normal | EffectBlendMode::Overlay => Ok(0),
            EffectBlendMode::Add => Ok(1),
            EffectBlendMode::Multiply => Ok(2),
            EffectBlendMode::Screen => Ok(3),
            _ => Err(RenderError::Unsupported(format!("backdrop blend {mode:?}"))),
        }
    }
}

use aster_render_ir::{
    BundleDependencies, ContractLevel, DecodeLimits, EffectBlendMode, FplnCodec,
    MotionReconstructionStatus, OwnedFpln, PlanSlice, ResourceRegistry,
};

use crate::RenderError;

/// Validated, owned execution inputs. No project evaluation or filesystem access occurs here.
pub struct SuppliedFrame {
    pub(crate) scene: crate::scene_input::SceneInput,
    pub(crate) surfaces: crate::surface_plan::SurfacePlan,
    pub(crate) post: Vec<u8>,
    pub(crate) surface: Option<crate::frame_surface::FrameSurface>,
    pub(crate) luts:
        std::collections::BTreeMap<aster_render_ir::ResourceHash, crate::lut_cache::LutInput>,
    pub(crate) output_clear: wgpu::Color,
    pub(crate) images:
        std::collections::BTreeMap<aster_render_ir::ResourceHash, crate::image_input::ImageInput>,
}

impl SuppliedFrame {
    pub fn new(
        plan: OwnedFpln,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
        decoded_images: &[aster_render_ir::PrecompositionMediaPixels],
    ) -> Result<Self, RenderError> {
        let Some(PlanSlice::FrameBundle(bundle)) = plan.metadata.slices.first() else {
            return Err(RenderError::Invalid("complete root bundle required".into()));
        };
        for hash in &plan.metadata.resources {
            registry.resolve(hash)?;
        }
        BundleDependencies::default().validate(&plan.metadata, registry, limits)?;
        if !bundle.temporal.is_empty() || !bundle.generators.is_empty() {
            return Err(RenderError::Unsupported(
                "temporal or generator pass".into(),
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
        {
            return Err(RenderError::Unsupported(
                "motion or diagnostic output".into(),
            ));
        }
        let auxiliary = bundle
            .auxiliary
            .as_ref()
            .map(|hash| stage(hash, ContractLevel::AuxiliarySliceV1))
            .transpose()?;
        let effect = bundle
            .effect
            .as_ref()
            .map(|hash| stage(hash, ContractLevel::PostEffectSliceV1))
            .transpose()?;
        let surface = crate::frame_surface::FrameSurface::new(
            &scene,
            &output,
            auxiliary.as_ref(),
            effect.as_ref(),
        )?;
        if !decoded_images.is_empty() && !bundle.media_pixels.is_empty() {
            return Err(RenderError::Invalid(
                "native and supplied image generations cannot be mixed".into(),
            ));
        }
        let scene = crate::scene_input::SceneInput::new(
            &scene,
            &root,
            &bundle.effects,
            if decoded_images.is_empty() {
                &bundle.media_pixels
            } else {
                decoded_images
            },
            registry,
            limits,
            false,
        )?;
        let surfaces = crate::surface_plan::SurfacePlan::collect(
            bundle.precompositions.as_ref(),
            &scene,
            registry,
            limits,
        )?;
        let mut images = scene.images.clone();
        if let Some(surface) = &surface {
            surface.validate_resources(&scene, &surfaces)?;
        }
        for surface in &surfaces.targets {
            for (hash, image) in &surface.scene.images {
                if images
                    .get(hash)
                    .is_some_and(|old| old.pixels != image.pixels)
                {
                    return Err(RenderError::Invalid(
                        "root and surface image generations differ".into(),
                    ));
                }
                images.insert(hash.clone(), image.clone());
            }
        }
        let mut luts = std::collections::BTreeMap::new();
        for scene in std::iter::once(&scene).chain(surfaces.targets.iter().map(|s| &s.scene)) {
            for hash in scene.layers.values().filter_map(|layer| layer.lut.as_ref()) {
                if !luts.contains_key(hash) {
                    luts.insert(
                        hash.clone(),
                        crate::lut_cache::LutInput::new(hash, registry)?,
                    );
                }
            }
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
            scene,
            surface,
            surfaces,
            post: post.blob(0)?.to_vec(),
            images,
            luts,
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

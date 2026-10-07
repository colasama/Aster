use aster_render_ir::{
    BundleDependencies, ContractLevel, DecodeLimits, EffectBlendMode, FplnCodec, OwnedFpln,
    PlanSlice, ResourceRegistry,
};

use crate::RenderError;

/// Validated, owned execution inputs. No project evaluation or filesystem access occurs here.
pub struct SuppliedFrame {
    pub(crate) depth: Option<crate::frame_depth::FrameDepth>,
    pub(crate) motion: Option<crate::frame_motion::FrameMotion>,
    pub(crate) temporal: crate::temporal_frame::TemporalFrame,
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
        if !bundle.generators.is_empty() {
            return Err(RenderError::Unsupported("generator pass".into()));
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
        let motion = crate::frame_motion::FrameMotion::new(&scene, &motion, auxiliary.as_ref())?;
        let depth = crate::frame_depth::FrameDepth::new(
            &scene,
            &output,
            auxiliary.as_ref(),
            effect.as_ref(),
            motion.is_some(),
        )?;
        let surface = if depth.is_some() {
            None
        } else {
            crate::frame_surface::FrameSurface::new(
                &scene,
                &output,
                auxiliary.as_ref(),
                effect.as_ref(),
                motion.is_some(),
            )?
        };
        let merged_pixels = bundle
            .media_pixels
            .iter()
            .chain(decoded_images)
            .cloned()
            .collect::<Vec<_>>();
        let pixels = &merged_pixels;
        let mut images = std::collections::BTreeMap::new();
        for record in pixels {
            let input = crate::image_input::ImageInput::from_record(record, registry)?;
            if images.insert(record.frame.clone(), input).is_some() {
                return Err(RenderError::Invalid(
                    "duplicate supplied media generation".into(),
                ));
            }
        }
        let Some(PlanSlice::SceneBuffers(geometry)) = scene.metadata.slices.first() else {
            return Err(RenderError::Invalid("root geometry absent".into()));
        };
        let root_frames = geometry
            .media_bindings
            .iter()
            .filter_map(|binding| match &binding.binding {
                aster_render_ir::MediaDrawBinding::Frame { hash } => Some(hash.clone()),
                _ => None,
            })
            .collect::<std::collections::BTreeSet<_>>();
        let root_pixels = pixels
            .iter()
            .filter(|record| root_frames.contains(&record.frame))
            .cloned()
            .collect::<Vec<_>>();
        let mut scene = crate::scene_input::SceneInput::new(
            &scene,
            &root,
            &bundle.effects,
            &root_pixels,
            registry,
            limits,
            false,
        )?;
        scene.shadow_size = bundle.shadow_map_size;
        let mut surfaces = crate::surface_plan::SurfacePlan::collect(
            bundle.precompositions.as_ref(),
            &scene,
            registry,
            limits,
            pixels,
        )?;
        if let Some(surface) = &surface {
            surface.validate_resources(&scene, &surfaces)?;
        }
        if let Some(auxiliary) = depth.as_ref().and_then(|d| d.auxiliary.as_ref()) {
            auxiliary.validate_resources(&scene, &surfaces)?;
        }
        if let Some(motion) = &motion {
            motion.auxiliary.validate_resources(&scene, &surfaces)?;
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
        let temporal = crate::temporal_frame::TemporalFrame::collect(
            &bundle.temporal,
            &plan.metadata.header,
            &images,
            registry,
            limits,
        )?;
        let required = scene
            .images
            .keys()
            .chain(
                surfaces
                    .targets
                    .iter()
                    .flat_map(|surface| surface.scene.images.keys()),
            )
            .chain(temporal.resources.iter())
            .cloned()
            .collect::<std::collections::BTreeSet<_>>();
        if required != images.keys().cloned().collect() {
            return Err(RenderError::Invalid(
                "frame media resource closure differs".into(),
            ));
        }
        temporal.resolve_generations(&mut scene.images);
        for surface in &mut surfaces.targets {
            temporal.resolve_generations(&mut surface.scene.images);
        }
        images.retain(|hash, _| !temporal.passes.contains_key(hash));
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
            depth,
            motion,
            temporal,
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

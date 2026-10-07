use crate::{RenderError, scene_input::SceneInput};
use aster_render_ir::{
    CompositionIdentity, ContractLevel, DecodeLimits, Extent2d, FplnCodec, PlanSlice, ResourceHash,
    ResourceRegistry, RootTextureReference,
};
use std::collections::{BTreeMap, BTreeSet};

pub(crate) struct SurfaceInput {
    pub key: Vec<u16>,
    pub size: Extent2d,
    pub scene: SceneInput,
}

#[derive(Default)]
pub(crate) struct SurfacePlan {
    pub targets: Vec<SurfaceInput>,
    pub bindings: BTreeMap<Vec<u16>, usize>,
}

impl SurfacePlan {
    pub fn key(id: &CompositionIdentity) -> Vec<u16> {
        match id {
            CompositionIdentity::Unicode(value) => value.encode_utf16().collect(),
            CompositionIdentity::Utf16(value) => value.utf16_units.clone(),
        }
    }

    pub fn collect(
        hash: Option<&ResourceHash>,
        root: &SceneInput,
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
        frame_pixels: &[aster_render_ir::PrecompositionMediaPixels],
    ) -> Result<Self, RenderError> {
        let mut result = Self::default();
        let Some(hash) = hash else {
            result.validate_references(root, 0)?;
            return Ok(result);
        };
        let bundle = FplnCodec::decode(registry.resolve(hash)?.to_vec(), limits)?;
        let Some(PlanSlice::PrecompositionBundle(records)) = bundle.metadata.slices.first() else {
            return Err(RenderError::Invalid("surface bundle required".into()));
        };
        if bundle.metadata.contract_level != ContractLevel::PrecompositionBundleSliceV1 {
            return Err(RenderError::Invalid(
                "surface bundle identity differs".into(),
            ));
        }
        let graph = FplnCodec::decode(registry.resolve(&records.graph)?.to_vec(), limits)?;
        let Some(PlanSlice::PrecompositionGraph(routing)) = graph.metadata.slices.first() else {
            return Err(RenderError::Invalid("surface graph required".into()));
        };
        if graph.metadata.contract_level != ContractLevel::PrecompositionGraphSliceV1
            || graph.metadata.header != bundle.metadata.header
            || routing.targets.len() != records.scenes.len()
        {
            return Err(RenderError::Invalid(
                "surface graph identity or count differs".into(),
            ));
        }
        let routes = graph
            .blob(routing.blob_index as usize)?
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect::<Vec<_>>();
        let mappings = bundle
            .blob(records.blob_index as usize)?
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect::<Vec<_>>();
        let mut offset = 4;
        let mut used_images = BTreeSet::new();
        for (index, (target, record)) in routing.targets.iter().zip(&records.scenes).enumerate() {
            if target.id != record.target_id
                || target.draw_count != record.draw_count
                || !record.generators.is_empty()
            {
                return Err(RenderError::Unsupported(
                    "surface identity, draw count or generator".into(),
                ));
            }
            let scene = FplnCodec::decode(registry.resolve(&record.scene)?.to_vec(), limits)?;
            if index == 0 && scene.metadata.header != bundle.metadata.header {
                return Err(RenderError::Invalid(
                    "surface graph origin differs from first scene".into(),
                ));
            }
            let commands = FplnCodec::decode(registry.resolve(&record.commands)?.to_vec(), limits)?;
            let Some(PlanSlice::SceneBuffers(geometry)) = scene.metadata.slices.first() else {
                return Err(RenderError::Invalid("surface geometry missing".into()));
            };
            let required = geometry
                .media_bindings
                .iter()
                .filter_map(|m| match &m.binding {
                    aster_render_ir::MediaDrawBinding::Frame { hash } => Some(hash.clone()),
                    _ => None,
                })
                .collect::<BTreeSet<_>>();
            let mut pixels = BTreeMap::new();
            for record in records.media_pixels.iter().chain(frame_pixels) {
                if required.contains(&record.frame)
                    && pixels
                        .insert(record.frame.clone(), record.clone())
                        .is_some_and(|old| old.pixels != record.pixels)
                {
                    return Err(RenderError::Invalid(
                        "surface media generations differ".into(),
                    ));
                }
            }
            let pixels = pixels.into_values().collect::<Vec<_>>();
            used_images.extend(required);
            let input = SceneInput::new(
                &scene,
                &commands,
                &record.effects,
                &pixels,
                registry,
                limits,
                true,
            )?;
            if input.header.render_target
                != (Extent2d {
                    width: target.width,
                    height: target.height,
                })
                || input.header.snapshot_scope != "precomposition-scenes"
                || input.root.draws.len() != record.draw_count as usize
                || target.has_effects != !input.layers.is_empty()
            {
                return Err(RenderError::Invalid(
                    "surface extent or execution differs".into(),
                ));
            }
            for (draw_index, draw) in input.root.draws.iter().enumerate() {
                let mapping = *mappings
                    .get(offset + draw_index)
                    .ok_or_else(|| RenderError::Invalid("surface mapping missing".into()))?;
                let geometry_draw = geometry.draws.get(mapping as usize).ok_or_else(|| {
                    RenderError::Invalid("surface geometry mapping out of range".into())
                })?;
                if draw.instance_id != geometry_draw.instance_id
                    || draw.first_vertex != geometry_draw.first_vertex
                    || draw.vertex_count != geometry_draw.vertex_count
                {
                    return Err(RenderError::Invalid(
                        "surface draw and geometry disagree".into(),
                    ));
                }
                let route = *routes
                    .get(offset + draw_index)
                    .ok_or_else(|| RenderError::Invalid("surface route missing".into()))?;
                let expected = match &draw.texture {
                    RootTextureReference::None | RootTextureReference::Media { .. } => 0,
                    RootTextureReference::Surface { instance_id } => {
                        let child =
                            result
                                .bindings
                                .get(&Self::key(instance_id))
                                .ok_or_else(|| {
                                    RenderError::Invalid(
                                        "surface child missing or forward reference".into(),
                                    )
                                })?;
                        *child as u32 + 2
                    }
                    _ => return Err(RenderError::Unsupported("surface texture type".into())),
                };
                if route != expected {
                    return Err(RenderError::Invalid(
                        "surface route disagrees with draw".into(),
                    ));
                }
            }
            result.validate_references(&input, index)?;
            let key = Self::key(&target.id);
            if result.bindings.insert(key.clone(), index).is_some() {
                return Err(RenderError::Invalid("duplicate surface identity".into()));
            }
            offset += record.draw_count as usize;
            result.targets.push(SurfaceInput {
                key,
                size: input.header.render_target,
                scene: input,
            });
        }
        if records
            .media_pixels
            .iter()
            .any(|p| !used_images.contains(&p.frame))
            || offset != routes.len()
            || offset != mappings.len()
        {
            return Err(RenderError::Invalid(
                "surface resource closure differs".into(),
            ));
        }
        for binding in &routing.bindings {
            if result
                .bindings
                .insert(
                    Self::key(&binding.instance_id),
                    binding.target_index as usize,
                )
                .is_some()
            {
                return Err(RenderError::Invalid(
                    "surface alias collides with identity".into(),
                ));
            }
        }
        result.validate_references(root, result.targets.len())?;
        Ok(result)
    }

    fn validate_references(&self, scene: &SceneInput, bound: usize) -> Result<(), RenderError> {
        for draw in &scene.root.draws {
            if let RootTextureReference::Surface { instance_id } = &draw.texture
                && self
                    .bindings
                    .get(&Self::key(instance_id))
                    .is_none_or(|index| *index >= bound)
            {
                return Err(RenderError::Invalid(
                    "surface binding missing or not child-first".into(),
                ));
            }
        }
        Ok(())
    }
}

use crate::{RenderError, image_input::ImageInput, layer_plan::LayerPlan};
use aster_render_ir::{
    ContractLevel, DecodeLimits, FrameHeaderSlice, OwnedFpln, PlanSlice,
    PrecompositionEffectRecord, PrecompositionMediaPixels, ResourceHash, ResourceRegistry,
    RootCommandRecord, RootSceneCommandsSlice, RootTextureReference,
};
use std::collections::BTreeMap;

pub(crate) struct SceneInput {
    pub header: FrameHeaderSlice,
    pub lighting: Vec<u8>,
    pub shadow_size: u32,
    pub shadow_draws: Vec<std::ops::Range<u32>>,
    pub vertices: Vec<u8>,
    pub root: RootSceneCommandsSlice,
    pub clears: Vec<[f64; 5]>,
    pub layers: BTreeMap<u32, LayerPlan>,
    pub images: BTreeMap<ResourceHash, ImageInput>,
    pub materials: BTreeMap<u32, crate::material_input::MaterialInput>,
}
impl SceneInput {
    pub fn new(
        scene: &OwnedFpln,
        root: &OwnedFpln,
        effects: &[PrecompositionEffectRecord],
        pixels: &[PrecompositionMediaPixels],
        registry: &ResourceRegistry,
        limits: &DecodeLimits,
        nested: bool,
    ) -> Result<Self, RenderError> {
        if scene.metadata.contract_level != ContractLevel::SceneBuffersSliceV1
            || root.metadata.contract_level != ContractLevel::RootSceneCommandsSliceV1
            || scene.metadata.header != root.metadata.header
        {
            return Err(RenderError::Invalid(
                "scene identity or contract differs".into(),
            ));
        }
        let layers = LayerPlan::collect(effects, root, registry, limits, nested)?;
        let Some(PlanSlice::SceneBuffers(scene_slice)) = scene.metadata.slices.first() else {
            return Err(RenderError::Invalid("scene buffers required".into()));
        };
        if nested
            && scene_slice.shadows_enabled
            && scene_slice.draws.iter().any(|draw| draw.casts_shadow)
        {
            return Err(RenderError::Unsupported("shadow draws".into()));
        }
        let Some(PlanSlice::RootSceneCommands(commands)) = root.metadata.slices.first() else {
            return Err(RenderError::Invalid("root commands required".into()));
        };
        let mut images =
            crate::image_input::ImageInput::collect(pixels, scene_slice, commands, registry)?;
        let materials = crate::material_input::MaterialInput::collect(root, registry)?;
        for image in materials.values().filter_map(|m| m.environment.as_ref()) {
            images.insert(image.frame.clone(), image.clone());
        }
        for draw in &commands.draws {
            if !matches!(
                draw.texture,
                RootTextureReference::None
                    | RootTextureReference::Media { .. }
                    | RootTextureReference::Surface { .. }
            ) {
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
                    crate::SuppliedFrame::blend_index(blend_mode)?;
                }
                RootCommandRecord::BeginLayer { effect_blob_index }
                | RootCommandRecord::Adjustment { effect_blob_index }
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
        Ok(Self {
            header: scene.metadata.header.clone(),
            lighting: scene_bytes[..592].to_vec(),
            shadow_size: 1,
            shadow_draws: scene_slice
                .draws
                .iter()
                .filter(|d| scene_slice.shadows_enabled && d.casts_shadow)
                .map(|d| d.first_vertex..d.first_vertex + d.vertex_count)
                .collect(),
            vertices: scene_bytes[592..592 + scene_slice.vertex_count as usize * 160].to_vec(),
            root: commands.clone(),
            clears,
            layers,
            images,
            materials,
        })
    }

    pub fn pyramid_levels(&self) -> crate::pyramid_levels::PyramidLevels {
        self.layers.values().fold(
            crate::pyramid_levels::PyramidLevels::default(),
            |levels, layer| levels.union(layer.pyramids),
        )
    }

    pub fn transient_bytes(&self) -> u64 {
        let size = self.header.render_target;
        let levels = self.pyramid_levels();
        self.vertices.len() as u64
            + 8192
            + self.materials.len() as u64 * 16
            + self
                .layers
                .values()
                .map(|l| l.uniforms.len() as u64 + l.operations.len() as u64 + 32)
                .sum::<u64>()
            + if self.layers.is_empty() {
                0
            } else {
                u64::from(size.width) * u64::from(size.height) * 20
            }
            + crate::pyramid::Pyramid::bytes(size, levels.blur)
            + crate::pyramid::Pyramid::bytes(size, levels.glow)
    }
}

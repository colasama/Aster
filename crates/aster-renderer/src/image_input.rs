use std::collections::{BTreeMap, BTreeSet};

use aster_render_ir::{
    ElementType, MediaDrawBinding, MediaSample, PrecompositionMediaPixels, ResourceDescriptor,
    ResourceHash, ResourceRegistry, RootSceneCommandsSlice, RootTextureReference,
    SceneBuffersSlice,
};

use crate::RenderError;

/// Frame identity and pixel generation are separate: the same frame may receive newer pixels.
#[derive(Clone)]
pub(crate) struct ImageInput {
    pub frame: ResourceHash,
    pub pixels: ResourceHash,
    pub width: u32,
    pub height: u32,
    pub format: aster_render_ir::MediaTextureFormat,
}

impl ImageInput {
    pub(crate) fn collect(
        records: &[PrecompositionMediaPixels],
        scene: &SceneBuffersSlice,
        root: &RootSceneCommandsSlice,
        registry: &ResourceRegistry,
    ) -> Result<BTreeMap<ResourceHash, Self>, RenderError> {
        let mut images = BTreeMap::new();
        for record in records {
            let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(&record.frame)? else {
                return Err(RenderError::Invalid(
                    "image frame descriptor missing".into(),
                ));
            };
            if frame.sample != MediaSample::Image {
                return Err(RenderError::Unsupported("non-still media sample".into()));
            }
            let ResourceDescriptor::Buffer(pixels) = registry.descriptor(&record.pixels)? else {
                return Err(RenderError::Invalid(
                    "image pixels require a byte buffer".into(),
                ));
            };
            let bytes = registry.resolve(&record.pixels)?;
            if pixels.element_type != ElementType::U8
                || u64::from(frame.width)
                    * u64::from(frame.height)
                    * u64::from(frame.format.bytes_per_pixel())
                    != bytes.len() as u64
            {
                return Err(RenderError::Invalid("image pixel extent differs".into()));
            }
            if images
                .insert(
                    record.frame.clone(),
                    Self {
                        frame: record.frame.clone(),
                        pixels: record.pixels.clone(),
                        width: frame.width,
                        height: frame.height,
                        format: frame.format,
                    },
                )
                .is_some()
            {
                return Err(RenderError::Invalid("duplicate image frame".into()));
            }
        }
        let mut required = BTreeSet::new();
        for media in &scene.media_bindings {
            let MediaDrawBinding::Frame { hash } = &media.binding else {
                return Err(RenderError::Unsupported("pending media sample".into()));
            };
            required.insert(hash.clone());
            if !images.contains_key(hash) {
                return Err(RenderError::Invalid("image pixel generation absent".into()));
            }
            let source = &scene.draws[media.draw_index as usize];
            if !root.draws.iter().any(|draw| {
                draw.instance_id == source.instance_id
                    && draw.first_vertex == source.first_vertex
                    && draw.vertex_count == source.vertex_count
                    && draw.texture == (RootTextureReference::Media { hash: hash.clone() })
            }) {
                return Err(RenderError::Invalid(
                    "image scene and root draw disagree".into(),
                ));
            }
        }
        let drawn = root
            .draws
            .iter()
            .filter_map(|draw| match &draw.texture {
                RootTextureReference::Media { hash } => Some(hash.clone()),
                _ => None,
            })
            .collect::<BTreeSet<_>>();
        if required != drawn || required != images.keys().cloned().collect() {
            return Err(RenderError::Invalid(
                "image resource closure differs".into(),
            ));
        }
        Ok(images)
    }
}

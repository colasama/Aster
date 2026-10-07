use std::collections::{BTreeMap, BTreeSet};

use aster_render_ir::{
    ElementType, MediaDrawBinding, MediaSample, PrecompositionMediaPixels, ResourceDescriptor,
    ResourceHash, ResourceRegistry, RootSceneCommandsSlice, RootTextureReference,
    SceneBuffersSlice,
};

use crate::RenderError;

#[derive(Clone, Copy)]
pub(crate) enum ImageFormat {
    Srgb8,
    Linear8,
    Linear16,
}

impl ImageFormat {
    pub fn bytes_per_pixel(self) -> u32 {
        match self {
            Self::Srgb8 | Self::Linear8 => 4,
            Self::Linear16 => 8,
        }
    }

    pub fn gpu(self) -> wgpu::TextureFormat {
        match self {
            Self::Srgb8 => wgpu::TextureFormat::Rgba8UnormSrgb,
            Self::Linear8 => wgpu::TextureFormat::Rgba8Unorm,
            Self::Linear16 => wgpu::TextureFormat::Rgba16Float,
        }
    }
}

impl From<aster_render_ir::MediaTextureFormat> for ImageFormat {
    fn from(value: aster_render_ir::MediaTextureFormat) -> Self {
        match value {
            aster_render_ir::MediaTextureFormat::Rgba8UnormSrgb => Self::Srgb8,
            aster_render_ir::MediaTextureFormat::Rgba16Float => Self::Linear16,
        }
    }
}

/// Frame identity and pixel generation are separate: the same frame may receive newer pixels.
#[derive(Clone)]
pub(crate) struct ImageInput {
    pub frame: ResourceHash,
    pub pixels: ResourceHash,
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
}

impl ImageInput {
    pub(crate) fn from_record(
        record: &PrecompositionMediaPixels,
        registry: &ResourceRegistry,
    ) -> Result<Self, RenderError> {
        let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(&record.frame)? else {
            return Err(RenderError::Invalid(
                "image frame descriptor missing".into(),
            ));
        };
        if !matches!(
            frame.sample,
            MediaSample::Image
                | MediaSample::Raster(_)
                | MediaSample::Sequence { .. }
                | MediaSample::Video { .. }
        ) {
            return Err(RenderError::Unsupported("non-still media sample".into()));
        }
        match registry.descriptor(&record.pixels)? {
            ResourceDescriptor::Buffer(pixels) if pixels.element_type == ElementType::U8 => {}
            ResourceDescriptor::RasterPixels(pixels) if pixels.frame == record.frame => {
                pixels.validate_frame(frame)?;
            }
            _ => {
                return Err(RenderError::Invalid(
                    "image pixel descriptor differs".into(),
                ));
            }
        }
        let bytes = registry.resolve(&record.pixels)?;
        if u64::from(frame.width)
            * u64::from(frame.height)
            * u64::from(frame.format.bytes_per_pixel())
            != bytes.len() as u64
        {
            return Err(RenderError::Invalid("image pixel extent differs".into()));
        }
        Ok(Self {
            frame: record.frame.clone(),
            pixels: record.pixels.clone(),
            width: frame.width,
            height: frame.height,
            format: frame.format.into(),
        })
    }

    pub(crate) fn collect(
        records: &[PrecompositionMediaPixels],
        scene: &SceneBuffersSlice,
        root: &RootSceneCommandsSlice,
        registry: &ResourceRegistry,
    ) -> Result<BTreeMap<ResourceHash, Self>, RenderError> {
        let mut images = BTreeMap::new();
        for record in records {
            let input = Self::from_record(record, registry)?;
            if images.insert(record.frame.clone(), input).is_some() {
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

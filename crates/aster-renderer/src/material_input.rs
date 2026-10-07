use std::collections::BTreeMap;

use aster_render_ir::{
    MaterialTextureReference, OwnedFpln, PlanSlice, ResourceDescriptor, ResourceHash,
    ResourceRegistry, TextureDimension, TexturePixelFormat,
};

use crate::{RenderError, image_input::ImageInput};

pub(crate) struct MaterialInput {
    pub uniforms: [u8; 16],
    pub normal: Option<ImageInput>,
    pub environment: Option<ImageInput>,
    pub active: bool,
}

impl MaterialInput {
    pub fn collect(
        root: &OwnedFpln,
        registry: &ResourceRegistry,
        decoded_textures: &BTreeMap<ResourceHash, ImageInput>,
    ) -> Result<BTreeMap<u32, Self>, RenderError> {
        let mut result = BTreeMap::new();
        for slice in &root.metadata.slices {
            let PlanSlice::MaterialBinding(material) = slice else {
                continue;
            };
            let normal = match &material.normal {
                MaterialTextureReference::Fallback => None,
                MaterialTextureReference::Texture { hash } => Some(
                    decoded_textures
                        .get(hash)
                        .ok_or_else(|| {
                            RenderError::Unsupported("native decoded normal texture absent".into())
                        })?
                        .clone(),
                ),
            };
            let mut values = [0_f64; 3];
            for (value, lane) in values
                .iter_mut()
                .zip(root.blob(material.blob_index as usize)?.chunks_exact(8))
            {
                *value = f64::from_le_bytes(
                    lane.try_into()
                        .map_err(|_| RenderError::Invalid("material scalar lane".into()))?,
                );
            }
            let environment = match &material.environment {
                MaterialTextureReference::Fallback => None,
                MaterialTextureReference::Texture { hash } => {
                    let ResourceDescriptor::TexturePixels(texture) = registry.descriptor(hash)?
                    else {
                        return Err(RenderError::Invalid(
                            "environment texture descriptor absent".into(),
                        ));
                    };
                    if texture.dimension != TextureDimension::D2
                        || texture.depth != 1
                        || texture.format != TexturePixelFormat::Rgba16Float
                    {
                        return Err(RenderError::Invalid(
                            "environment must be a two-dimensional HDR texture".into(),
                        ));
                    }
                    texture.validate(registry.resolve(hash)?)?;
                    Some(ImageInput {
                        frame: hash.clone(),
                        pixels: hash.clone(),
                        width: texture.width,
                        height: texture.height,
                        format: crate::image_input::ImageFormat::Linear16,
                    })
                }
            };
            let mut uniforms = [0; 16];
            for (lane, value) in uniforms.chunks_exact_mut(4).zip([
                values[0],
                values[1],
                f64::from(normal.is_some()),
                values[2],
            ]) {
                lane.copy_from_slice(&(value as f32).to_le_bytes());
            }
            result.insert(
                material.blob_index,
                Self {
                    uniforms,
                    active: normal.is_some() || values[1] > 0.0,
                    normal,
                    environment,
                },
            );
        }
        Ok(result)
    }
}

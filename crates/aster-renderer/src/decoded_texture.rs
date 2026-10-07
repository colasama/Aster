use std::collections::BTreeMap;

use aster_render_ir::{
    ResourceDescriptor, ResourceHash, ResourceRegistry, TextureDimension, TexturePixelFormat,
};

use crate::{
    RenderError,
    image_input::{ImageFormat, ImageInput},
};

/// Native decode output links two independently authenticated content identities.
pub struct DecodedTexturePixels {
    pub encoded: ResourceHash,
    pub pixels: ResourceHash,
}

impl DecodedTexturePixels {
    pub(crate) fn collect(
        records: &[Self],
        registry: &ResourceRegistry,
    ) -> Result<BTreeMap<ResourceHash, ImageInput>, RenderError> {
        let mut images = BTreeMap::new();
        for record in records {
            if !matches!(
                registry.descriptor(&record.encoded)?,
                ResourceDescriptor::EncodedTexture(_)
            ) {
                return Err(RenderError::Invalid(
                    "encoded normal descriptor absent".into(),
                ));
            }
            let ResourceDescriptor::TexturePixels(texture) = registry.descriptor(&record.pixels)?
            else {
                return Err(RenderError::Invalid(
                    "decoded normal descriptor absent".into(),
                ));
            };
            if texture.dimension != TextureDimension::D2
                || texture.depth != 1
                || texture.format != TexturePixelFormat::Rgba8Unorm
            {
                return Err(RenderError::Invalid(
                    "normal must be a linear two-dimensional texture".into(),
                ));
            }
            texture.validate(registry.resolve(&record.pixels)?)?;
            if images
                .insert(
                    record.encoded.clone(),
                    ImageInput {
                        frame: record.encoded.clone(),
                        pixels: record.pixels.clone(),
                        width: texture.width,
                        height: texture.height,
                        format: ImageFormat::Linear8,
                    },
                )
                .is_some()
            {
                return Err(RenderError::Invalid(
                    "duplicate decoded normal generation".into(),
                ));
            }
        }
        Ok(images)
    }
}

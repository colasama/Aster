use crate::{
    EncodedTextureDescriptor, IrError, ResourceDescriptor, ResourceHash, ResourceKind,
    TextureColorConversion, TextureEncoding, TexturePixelFormat,
};

#[test]
fn encoded_texture_identity_and_framing_are_checked() -> Result<(), IrError> {
    let mut descriptor = EncodedTextureDescriptor {
        encoding: TextureEncoding::Png,
        format: TexturePixelFormat::Rgba8Unorm,
        color_space_conversion: TextureColorConversion::None,
    };
    let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10, 0];
    let first = ResourceHash::for_resource(
        ResourceKind::EncodedTexture,
        &ResourceDescriptor::EncodedTexture(descriptor.clone()),
        &bytes,
    )?;
    bytes[8] = 1;
    assert_ne!(
        first,
        ResourceHash::for_resource(
            ResourceKind::EncodedTexture,
            &ResourceDescriptor::EncodedTexture(descriptor.clone()),
            &bytes
        )?
    );
    descriptor.encoding = TextureEncoding::Jpeg;
    assert!(descriptor.validate(&bytes).is_err());
    descriptor.validate(&[255, 216, 255])?;
    descriptor.encoding = TextureEncoding::Webp;
    descriptor.validate(b"RIFF\0\0\0\0WEBP")?;
    assert!(descriptor.validate(b"RIFF").is_err());
    descriptor.format = TexturePixelFormat::Rgba16Float;
    assert!(descriptor.validate(b"RIFF\0\0\0\0WEBP").is_err());
    Ok(())
}

use crate::{
    IrError, ResourceDescriptor, ResourceHash, ResourceKind, TextureDimension, TexturePixelFormat,
    TexturePixelsDescriptor,
};

#[test]
fn packed_texture_identity_includes_layout_and_exact_payload() -> Result<(), IrError> {
    let mut texture = TexturePixelsDescriptor {
        dimension: TextureDimension::D3,
        width: 2,
        height: 2,
        depth: 2,
        format: TexturePixelFormat::Rgba16Float,
    };
    let bytes = vec![0; 64];
    let hash = ResourceHash::for_resource(
        ResourceKind::TexturePixels,
        &ResourceDescriptor::TexturePixels(texture.clone()),
        &bytes,
    )?;
    let mut changed = bytes.clone();
    changed[0] = 1;
    assert_ne!(
        hash,
        ResourceHash::for_resource(
            ResourceKind::TexturePixels,
            &ResourceDescriptor::TexturePixels(texture.clone()),
            &changed
        )?
    );
    texture.dimension = TextureDimension::D2;
    assert!(matches!(
        texture.validate(&bytes),
        Err(IrError::InvalidResource(_))
    ));
    texture.depth = 1;
    assert!(matches!(
        texture.validate(&bytes),
        Err(IrError::ElementCountMismatch)
    ));
    texture.width = 8193;
    assert!(matches!(
        texture.validate(&bytes),
        Err(IrError::InvalidResource(_))
    ));
    Ok(())
}

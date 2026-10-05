use super::Fixture;
use crate::{
    CompositionIdentity, ContractLevel, DecodeLimits, ElementType, FplnCodec, IrError,
    MaterialBindingSlice, MaterialTextureReference, PlanSlice, ResourceHash,
};

#[test]
fn material_bindings_preserve_scalar_bits_and_reject_missing_resources() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    metadata.contract_level = ContractLevel::MaterialBindingsSliceV1;
    metadata.resources = ["a", "b"].map(|s| ResourceHash(s.repeat(64))).to_vec();
    metadata.blobs.truncate(1);
    metadata.blobs[0].byte_length = 24;
    metadata.blobs[0].element_count = 24;
    metadata.blobs[0].element_type = ElementType::U8;
    metadata.slices = vec![PlanSlice::MaterialBinding(MaterialBindingSlice {
        blob_index: 0,
        instance_id: CompositionIdentity::Unicode("mesh".to_owned()),
        normal: MaterialTextureReference::Texture {
            hash: metadata.resources[0].clone(),
        },
        environment: MaterialTextureReference::Texture {
            hash: metadata.resources[1].clone(),
        },
    })];
    let bytes: Vec<u8> = [-0.0_f64, f64::from_bits(1), 1.0 / 3.0]
        .into_iter()
        .flat_map(f64::to_le_bytes)
        .collect();
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &DecodeLimits::default())?;
    let decoded = FplnCodec::decode(encoded.clone(), &DecodeLimits::default())?;
    assert_eq!(decoded.blob(0)?, bytes);
    assert_eq!(decoded.reencode(&DecodeLimits::default())?, encoded);
    for (offset, value) in [
        (0, f64::NAN),
        (0, 9.0),
        (8, -1.0),
        (8, f64::INFINITY),
        (16, 1.0),
    ] {
        let mut invalid = bytes.clone();
        invalid[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(
            FplnCodec::encode(metadata.clone(), &[&invalid], &DecodeLimits::default()),
            Err(IrError::InvalidMaterialBinding(_))
        ));
    }
    let mut missing = metadata.clone();
    missing.resources.pop();
    assert!(matches!(
        missing.validate(&DecodeLimits::default()),
        Err(IrError::InvalidMaterialBinding(_))
    ));
    if let PlanSlice::MaterialBinding(binding) = &mut metadata.slices[0] {
        binding.environment = MaterialTextureReference::Fallback;
    }
    assert!(matches!(
        FplnCodec::encode(metadata, &[&bytes], &DecodeLimits::default()),
        Err(IrError::InvalidMaterialBinding(_))
    ));
    Ok(())
}

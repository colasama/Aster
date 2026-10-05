use super::Fixture;
use crate::{
    CompositionIdentity, ContractLevel, DecodeLimits, EffectBlendMode, EffectRoute, ElementType,
    FplnCodec, IrError, LayerEffectSlice, PlanSlice, ResourceHash,
};

#[test]
fn effect_controls_and_lut_references_are_validated_without_changing_program_bits()
-> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    metadata.contract_level = ContractLevel::LayerEffectsSliceV1;
    metadata.resources = vec![ResourceHash("a".repeat(64))];
    metadata.blobs.truncate(1);
    metadata.blobs[0].byte_length = 4200;
    metadata.blobs[0].element_count = 4200;
    metadata.blobs[0].element_type = ElementType::U8;
    metadata.slices = vec![PlanSlice::LayerEffect(LayerEffectSlice {
        blob_index: 0,
        instance_id: CompositionIdentity::Unicode("effect".to_owned()),
        blend_mode: EffectBlendMode::SoftLight,
        route: EffectRoute::Layer,
        operation_count: 1,
        uses_blur: false,
        uses_glow: false,
        lut_hash: metadata.resources[0].clone(),
    })];
    let mut bytes = vec![0_u8; 4200];
    for (index, value) in [
        (0, metadata.header.render_target.width as f32),
        (1, metadata.header.render_target.height as f32),
        (16, 1.0),
        (17, 1.0),
        (18, 7.0),
    ] {
        bytes[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes[4184..4188].copy_from_slice(&0x7fc01234_u32.to_le_bytes());
    bytes[4192..].copy_from_slice(&(1.0_f64 / 3.0).to_le_bytes());
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &DecodeLimits::default())?;
    let decoded = FplnCodec::decode(encoded.clone(), &DecodeLimits::default())?;
    assert_eq!(decoded.blob(0)?, bytes);
    assert_eq!(decoded.reencode(&DecodeLimits::default())?, encoded);
    for (offset, value) in [(64, 2.0_f32), (68, 0.0), (72, 8.0), (76, 1.0)] {
        let mut invalid = bytes.clone();
        invalid[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(
            FplnCodec::encode(metadata.clone(), &[&invalid], &DecodeLimits::default()),
            Err(IrError::InvalidLayerEffect(_))
        ));
    }
    metadata.resources.clear();
    assert!(matches!(
        metadata.validate(&DecodeLimits::default()),
        Err(IrError::InvalidLayerEffect(_))
    ));
    Ok(())
}

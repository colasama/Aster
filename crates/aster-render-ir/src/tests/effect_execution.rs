use super::Fixture;
use crate::{
    CompositionIdentity, ContractLevel, DecodeLimits, EffectBlendMode, EffectComposite,
    EffectExecutionRoute, EffectExecutionSlice, ElementType, FplnCodec, IrError, PlanSlice,
};

#[test]
fn execution_rejects_inconsistent_composites_and_fusion_counts() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    metadata.contract_level = ContractLevel::EffectExecutionSliceV1;
    metadata.resources.clear();
    metadata.blobs.truncate(1);
    metadata.blobs[0].element_type = ElementType::U32Le;
    metadata.blobs[0].byte_length = 16;
    metadata.blobs[0].element_count = 4;
    metadata.slices = vec![PlanSlice::EffectExecution(EffectExecutionSlice {
        blob_index: 0,
        instance_id: CompositionIdentity::Unicode("instance".to_owned()),
        layer_id: CompositionIdentity::Unicode("layer".to_owned()),
        route: EffectExecutionRoute::Layer,
        blend_mode: EffectBlendMode::Multiply,
        composite: EffectComposite::Backdrop,
    })];
    let bytes: Vec<u8> = [64_u32, 1, 6, 64]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &DecodeLimits::default())?;
    assert_eq!(
        FplnCodec::decode(encoded.clone(), &DecodeLimits::default())?
            .reencode(&DecodeLimits::default())?,
        encoded
    );
    let mut invalid = bytes.clone();
    invalid[12..].copy_from_slice(&65_u32.to_le_bytes());
    assert!(matches!(
        FplnCodec::encode(metadata.clone(), &[&invalid], &DecodeLimits::default()),
        Err(IrError::InvalidEffectExecution(_))
    ));
    if let PlanSlice::EffectExecution(execution) = &mut metadata.slices[0] {
        execution.composite = EffectComposite::Fixed;
    }
    assert!(matches!(
        metadata.validate(&DecodeLimits::default()),
        Err(IrError::InvalidEffectExecution(_))
    ));
    Ok(())
}

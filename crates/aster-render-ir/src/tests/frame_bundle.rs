use super::Fixture;
use crate::{
    ContractLevel, DecodeLimits, ElementType, FplnCodec, FrameBundleSlice, IrError, PlanSlice,
    ResourceHash,
};

#[test]
fn root_bundle_uses_typed_count_payload_and_requires_declared_stages() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    let stage = ResourceHash("a".repeat(64));
    metadata.contract_level = ContractLevel::FrameBundleSliceV1;
    metadata.resources = vec![stage.clone()];
    metadata.blobs.truncate(1);
    metadata.blobs[0].element_type = ElementType::U32Le;
    metadata.blobs[0].byte_length = 16;
    metadata.blobs[0].element_count = 4;
    metadata.slices = vec![PlanSlice::FrameBundle(FrameBundleSlice {
        blob_index: 0,
        scene: stage.clone(),
        root: stage.clone(),
        post: stage.clone(),
        motion: stage.clone(),
        output: stage,
        auxiliary: None,
        effect: None,
        precompositions: None,
        shadow_map_size: 1024,
        effects: Vec::new(),
        generators: Vec::new(),
    })];
    let bytes: Vec<u8> = [1024_u32, 0, 0, 0]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
    let limits = DecodeLimits::default();
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &limits)?;
    assert_eq!(
        FplnCodec::decode(encoded.clone(), &limits)?.reencode(&limits)?,
        encoded
    );
    let mut wrong_count = bytes.clone();
    wrong_count[4] = 1;
    assert!(matches!(
        FplnCodec::encode(metadata.clone(), &[&wrong_count], &limits),
        Err(IrError::InvalidHeader(_))
    ));
    metadata.resources.clear();
    assert!(matches!(
        FplnCodec::encode(metadata, &[&bytes], &limits),
        Err(IrError::MissingResource(_))
    ));
    Ok(())
}

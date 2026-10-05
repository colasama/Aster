use super::Fixture;
use crate::{
    ContractLevel, DecodeLimits, ElementType, FplnCodec, FrameBundleSlice, IrError, PlanSlice,
    PrecompositionMediaPixels, ResourceHash,
};

#[test]
fn root_bundle_uses_typed_count_payload_and_requires_declared_stages() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    let stage = ResourceHash("a".repeat(64));
    metadata.contract_level = ContractLevel::FrameBundleSliceV1;
    metadata.resources = vec![stage.clone()];
    metadata.blobs.truncate(1);
    metadata.blobs[0].element_type = ElementType::U32Le;
    metadata.blobs[0].byte_length = 24;
    metadata.blobs[0].element_count = 6;
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
        media_pixels: Vec::new(),
        temporal: Vec::new(),
    })];
    let bytes: Vec<u8> = [1024_u32, 0, 0, 0, 0, 0]
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
    let mut captured = metadata.clone();
    if let PlanSlice::FrameBundle(bundle) = &mut captured.slices[0] {
        bundle.media_pixels.push(PrecompositionMediaPixels {
            frame: bundle.scene.clone(),
            pixels: bundle.scene.clone(),
        });
    }
    let mut capture_bytes = bytes.clone();
    capture_bytes[16] = 1;
    let captured_bytes = FplnCodec::encode(captured.clone(), &[&capture_bytes], &limits)?;
    assert_eq!(
        FplnCodec::decode(captured_bytes.clone(), &limits)?.reencode(&limits)?,
        captured_bytes
    );
    if let PlanSlice::FrameBundle(bundle) = &mut captured.slices[0] {
        bundle.media_pixels.push(bundle.media_pixels[0].clone());
    }
    capture_bytes[16] = 2;
    assert!(matches!(
        FplnCodec::encode(captured, &[&capture_bytes], &limits),
        Err(IrError::InvalidResource(_))
    ));
    let mut temporal = metadata.clone();
    if let PlanSlice::FrameBundle(bundle) = &mut temporal.slices[0] {
        bundle.temporal.push(bundle.scene.clone());
    }
    let mut temporal_bytes = bytes.clone();
    temporal_bytes[20] = 1;
    let encoded = FplnCodec::encode(temporal.clone(), &[&temporal_bytes], &limits)?;
    assert_eq!(
        FplnCodec::decode(encoded.clone(), &limits)?.reencode(&limits)?,
        encoded
    );
    if let PlanSlice::FrameBundle(bundle) = &mut temporal.slices[0] {
        bundle.temporal.push(bundle.temporal[0].clone());
    }
    temporal_bytes[20] = 2;
    assert!(matches!(
        FplnCodec::encode(temporal, &[&temporal_bytes], &limits),
        Err(IrError::InvalidResource(_))
    ));
    metadata.resources.clear();
    assert!(matches!(
        FplnCodec::encode(metadata, &[&bytes], &limits),
        Err(IrError::MissingResource(_))
    ));
    Ok(())
}

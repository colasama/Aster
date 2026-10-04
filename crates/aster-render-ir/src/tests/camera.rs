use super::Fixture;
use crate::{
    CameraIrisShape, CameraParametersSlice, CameraPoseMode, CameraProjectionKind, ContractLevel,
    DecodeLimits, ElementType, FplnCodec, IrError, PlanSlice,
};

#[test]
fn camera_f64_payload_and_closed_variants_survive_owned_roundtrip() -> Result<(), IrError> {
    let fixture = Fixture::new()?;
    let mut metadata = fixture.metadata;
    metadata.contract_level = ContractLevel::CameraParametersSliceV1;
    metadata.blobs.truncate(1);
    metadata.blobs[0].byte_length = 296;
    metadata.blobs[0].element_count = 296;
    metadata.blobs[0].element_type = ElementType::U8;
    metadata.slices = vec![PlanSlice::CameraParameters(CameraParametersSlice {
        blob_index: 0,
        pose_mode: CameraPoseMode::TwoNode,
        projection_kind: CameraProjectionKind::Perspective,
        optics_projection: CameraProjectionKind::Perspective,
        depth_of_field: true,
        lock_focus_to_zoom: false,
        iris_shape: CameraIrisShape::Hexagon,
    })];
    let mut bytes = vec![0_u8; 296];
    bytes[..8].copy_from_slice(&(-0.0_f64).to_le_bytes());
    bytes[8..16].copy_from_slice(&(1.0_f64 + f64::EPSILON).to_le_bytes());
    bytes[16..24].copy_from_slice(&1_u64.to_le_bytes());
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &DecodeLimits::default())?;
    let decoded = FplnCodec::decode(encoded.clone(), &DecodeLimits::default())?;
    assert_eq!(decoded.metadata, metadata);
    assert_eq!(decoded.blob(0)?, bytes);
    assert_eq!(decoded.reencode(&DecodeLimits::default())?, encoded);
    metadata.blobs[0].byte_length -= 8;
    metadata.blobs[0].element_count -= 8;
    assert!(metadata.validate(&DecodeLimits::default()).is_err());
    Ok(())
}

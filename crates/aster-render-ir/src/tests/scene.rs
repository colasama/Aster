use super::Fixture;
use crate::{
    CompositionIdentity, ContractLevel, DecodeLimits, ElementType, FplnCodec, IrError, PlanSlice,
    SceneBuffersSlice, SceneDrawRecord,
};

#[test]
fn scene_bytes_and_stable_draws_roundtrip_without_float_reinterpretation() -> Result<(), IrError> {
    let fixture = Fixture::new()?;
    let mut metadata = fixture.metadata;
    metadata.contract_level = ContractLevel::SceneBuffersSliceV1;
    metadata.blobs.truncate(1);
    metadata.blobs[0].byte_length = 760;
    metadata.blobs[0].element_count = 190;
    metadata.blobs[0].element_type = ElementType::F32Le;
    metadata.slices = vec![PlanSlice::SceneBuffers(SceneBuffersSlice {
        blob_index: 0,
        vertex_count: 1,
        motion_vectors: true,
        shadows_enabled: true,
        draws: vec![SceneDrawRecord {
            instance_id: CompositionIdentity::Unicode("nested/mesh".to_owned()),
            resource_instance_id: CompositionIdentity::Unicode("resource".to_owned()),
            selection_id: CompositionIdentity::Unicode("selection".to_owned()),
            first_vertex: 0,
            vertex_count: 1,
            casts_shadow: true,
        }],
    })];
    let mut bytes = vec![0_u8; 760];
    bytes[592..596].copy_from_slice(&0x7fc0_1234_u32.to_le_bytes());
    bytes[752..756].copy_from_slice(&(-0.0_f32).to_le_bytes());
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &DecodeLimits::default())?;
    let decoded = FplnCodec::decode(encoded.clone(), &DecodeLimits::default())?;
    assert_eq!(decoded.metadata, metadata);
    assert_eq!(decoded.blob(0)?, bytes);
    assert_eq!(decoded.reencode(&DecodeLimits::default())?, encoded);
    if let PlanSlice::SceneBuffers(scene) = &mut metadata.slices[0] {
        scene.draws[0].first_vertex = 1;
    }
    assert!(metadata.validate(&DecodeLimits::default()).is_err());
    Ok(())
}

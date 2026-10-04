use super::Fixture;
use crate::{
    CompositionIdentity, ContractLevel, DecodeLimits, ElementType, FplnCodec, FrameTime, IrError,
    PlanSlice, TemporalTextFormat, TemporalTextSamplesSlice,
};

#[test]
fn temporal_samples_preserve_exact_f64_values_and_reject_invalid_exposure() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    metadata.contract_level = ContractLevel::TemporalTextSamplesSliceV1;
    metadata.header.time = FrameTime::from_f64(-0.0)?;
    metadata.resources.clear();
    metadata.blobs.truncate(1);
    metadata.blobs[0].byte_length = 64;
    metadata.blobs[0].element_count = 64;
    metadata.blobs[0].element_type = ElementType::U8;
    metadata.slices = vec![PlanSlice::TemporalTextSamples(TemporalTextSamplesSlice {
        blob_index: 0,
        resource_instance_id: CompositionIdentity::Unicode("root/text".to_owned()),
        sample_count: 8,
        unique_sample_count: 2,
        exposure_only: true,
        sample_format: TemporalTextFormat::Rgba8UnormSrgb,
        accumulation_format: TemporalTextFormat::Rgba16Float,
        resolve_format: TemporalTextFormat::Rgba8UnormSrgb,
    })];
    let values = [
        -0.0,
        0.25,
        -0.0,
        0.25,
        -0.0,
        1001.0 / 30000.0 + f64::EPSILON,
        0.5,
        33367.0,
    ];
    let bytes: Vec<u8> = values.into_iter().flat_map(f64::to_le_bytes).collect();
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &DecodeLimits::default())?;
    let decoded = FplnCodec::decode(encoded.clone(), &DecodeLimits::default())?;
    assert_eq!(decoded.metadata, metadata);
    assert_eq!(decoded.blob(0)?, bytes);
    assert_eq!(decoded.reencode(&DecodeLimits::default())?, encoded);
    for (offset, value) in [(0, 0.0), (8, 0.5), (16, f64::NAN), (24, -1.0), (32, 0.5)] {
        let mut invalid = bytes.clone();
        invalid[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(
            FplnCodec::encode(metadata.clone(), &[&invalid], &DecodeLimits::default()),
            Err(IrError::InvalidTemporalText(_))
        ));
    }
    if let PlanSlice::TemporalTextSamples(slice) = &mut metadata.slices[0] {
        slice.accumulation_format = TemporalTextFormat::Rgba8UnormSrgb;
    }
    assert!(metadata.validate(&DecodeLimits::default()).is_err());
    Ok(())
}

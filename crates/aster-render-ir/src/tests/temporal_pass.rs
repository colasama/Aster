use super::Fixture;
use crate::{
    ContractLevel, DecodeLimits, ElementType, FplnCodec, IrError, PlanSlice, ResourceHash,
    TemporalTextFormat, TemporalTextPassesSlice,
};

#[test]
fn temporal_passes_preserve_weights_and_reject_invalid_dependencies() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    metadata.contract_level = ContractLevel::TemporalTextPassesSliceV1;
    metadata.resources = ["a", "b", "c"].map(|c| ResourceHash(c.repeat(64))).to_vec();
    metadata.blobs.truncate(1);
    metadata.blobs[0].byte_length = 24;
    metadata.blobs[0].element_count = 24;
    metadata.blobs[0].element_type = ElementType::U8;
    metadata.slices = vec![PlanSlice::TemporalTextPasses(TemporalTextPassesSlice {
        blob_index: 0,
        width: 64,
        height: 32,
        output: metadata.resources[0].clone(),
        samples: metadata.resources[1..].to_vec(),
        sample_format: TemporalTextFormat::Rgba8UnormSrgb,
        accumulation_format: TemporalTextFormat::Rgba16Float,
        output_format: TemporalTextFormat::Rgba8UnormSrgb,
    })];
    let bytes: Vec<u8> = [0.5_f64, -0.0, 0.5]
        .into_iter()
        .flat_map(f64::to_le_bytes)
        .collect();
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &DecodeLimits::default())?;
    let decoded = FplnCodec::decode(encoded.clone(), &DecodeLimits::default())?;
    assert_eq!(decoded.metadata, metadata);
    assert_eq!(decoded.blob(0)?, bytes);
    assert_eq!(decoded.reencode(&DecodeLimits::default())?, encoded);
    for (offset, value) in [(0, 0.0_f64), (8, f64::NAN), (16, -0.5)] {
        let mut invalid = bytes.clone();
        invalid[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(
            FplnCodec::encode(metadata.clone(), &[&invalid], &DecodeLimits::default()),
            Err(IrError::InvalidTemporalText(_))
        ));
    }
    let mut missing = metadata.clone();
    missing.resources.pop();
    assert!(matches!(
        missing.validate(&DecodeLimits::default()),
        Err(IrError::InvalidTemporalText(_))
    ));
    if let PlanSlice::TemporalTextPasses(slice) = &mut metadata.slices[0] {
        slice.samples[0] = slice.output.clone();
    }
    assert!(matches!(
        metadata.validate(&DecodeLimits::default()),
        Err(IrError::InvalidTemporalText(_))
    ));
    Ok(())
}

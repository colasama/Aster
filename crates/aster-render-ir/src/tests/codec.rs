use crate::{
    CompositionIdentity, DecodeLimits, FplnCodec, FrameTime, IrError, IrFixture,
    canonical::CanonicalJson, wire::WireHeader,
};

use super::Fixture;

#[test]
fn typed_roundtrip_rebuilds_metadata_and_borrows_original_blob_ranges() -> Result<(), IrError> {
    let fixture = Fixture::new()?;
    let original = fixture.encode()?;
    let input = original.clone();
    let base = input.as_ptr();
    let start = WireHeader::read(&input)?.blob_section_offset as usize;
    let mut decoded = FplnCodec::decode(input, &DecodeLimits::default())?;
    assert_eq!(decoded.metadata, fixture.metadata);
    assert_eq!(decoded.blob(0)?.as_ptr(), base.wrapping_add(start));
    assert_eq!(decoded.blob(1)?.as_ptr(), base.wrapping_add(start + 96));
    assert_eq!(&decoded.blob(0)?[12..16], &(-0.0_f32).to_le_bytes());
    assert_eq!(decoded.reencode(&DecodeLimits::default())?, original);
    decoded.metadata.header.composition_id =
        CompositionIdentity::Unicode("new serialized identity \" \\ \n 空 🦀".to_owned());
    let rebuilt = decoded.reencode(&DecodeLimits::default())?;
    assert_ne!(rebuilt, original);
    let restored = FplnCodec::decode(rebuilt, &DecodeLimits::default())?;
    assert_eq!(restored.metadata, decoded.metadata);
    assert_eq!(restored.blob(0)?, fixture.blobs[0]);
    assert_eq!(restored.blob(1)?, fixture.blobs[1]);
    Ok(())
}

#[test]
fn header_lengths_versions_limits_and_padding_fail_closed() -> Result<(), IrError> {
    let fixture = Fixture::new()?;
    let original = fixture.encode()?;
    let limits = DecodeLimits::default();
    for length in 0..32 {
        assert!(matches!(
            FplnCodec::decode(original[..length].to_vec(), &limits),
            Err(IrError::TruncatedHeader)
        ));
    }
    let mut altered = original.clone();
    altered[0] = b'X';
    assert!(matches!(
        FplnCodec::decode(altered, &limits),
        Err(IrError::InvalidMagic)
    ));
    let mut altered = original.clone();
    altered[4] = 2;
    assert!(matches!(
        FplnCodec::decode(altered, &limits),
        Err(IrError::UnsupportedVersion(2))
    ));
    for offset in [6, 24, 28] {
        let mut altered = original.clone();
        altered[offset] ^= 1;
        assert!(matches!(
            FplnCodec::decode(altered, &limits),
            Err(IrError::InvalidHeader(_))
        ));
    }
    assert!(matches!(
        FplnCodec::decode(original[..original.len() - 1].to_vec(), &limits),
        Err(IrError::ContainerLengthMismatch)
    ));
    let mut altered = original.clone();
    altered.push(0);
    assert!(matches!(
        FplnCodec::decode(altered, &limits),
        Err(IrError::ContainerLengthMismatch)
    ));
    let low = DecodeLimits {
        max_container_bytes: original.len() - 1,
        max_metadata_bytes: original.len() - 1,
        ..limits.clone()
    };
    assert!(matches!(
        FplnCodec::decode(original.clone(), &low),
        Err(IrError::LimitExceeded(_))
    ));
    let header = WireHeader::read(&original)?;
    assert!(header.blob_section_offset > 32 + header.metadata_bytes);
    let mut altered = original;
    altered[(32 + header.metadata_bytes) as usize] = 1;
    assert!(matches!(
        FplnCodec::decode(altered, &limits),
        Err(IrError::InvalidPadding)
    ));
    Ok(())
}

#[test]
fn canonical_json_rejects_unknown_duplicate_float_and_alternate_forms() -> Result<(), IrError> {
    let fixture = Fixture::new()?;
    let canonical = CanonicalJson::encode(&fixture.metadata)?;
    let json = String::from_utf8(canonical).map_err(|_| IrError::InvalidUtf8)?;
    for altered in [
        format!(" {json}"),
        json.replacen(
            "\"plan_version\":1",
            "\"plan_version\":1,\"plan_version\":1",
            1,
        ),
        json.replacen("\"plan_version\":1", "\"plan_version\":1.0", 1),
        json.replacen(
            "\"plan_version\":1",
            "\"unexpected\":true,\"plan_version\":1",
            1,
        ),
        json.replace("post_process_uniforms", "future_draw"),
        json.replace("空", "\\u7a7a"),
    ] {
        assert!(
            FplnCodec::decode(
                Fixture::unchecked_json(altered.as_bytes(), &fixture.blobs)?,
                &DecodeLimits::default()
            )
            .is_err()
        );
    }
    let mut invalid_utf8 = json.into_bytes();
    invalid_utf8[0] = 0xff;
    assert!(matches!(
        FplnCodec::decode(
            Fixture::unchecked_json(&invalid_utf8, &fixture.blobs)?,
            &DecodeLimits::default()
        ),
        Err(IrError::InvalidUtf8)
    ));
    Ok(())
}

#[test]
fn unsafe_integers_rationals_and_incomplete_contract_are_not_normalized() -> Result<(), IrError> {
    let mut fixture = Fixture::new()?;
    fixture.metadata.header.project_revision = 9_007_199_254_740_992;
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::InvalidSafeInteger)
    ));
    fixture.metadata.header.project_revision = 0;
    fixture.metadata.header.time = FrameTime::Rational {
        value: 500,
        scale: 1000,
    };
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::InvalidRational)
    ));
    fixture.metadata.header.time = FrameTime::Rational { value: 0, scale: 1 };
    fixture.metadata.renderer_plan_complete = true;
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::IncompleteFramePlan)
    ));
    Ok(())
}

#[test]
fn blob_descriptors_and_uniform_bytes_cannot_hide_missing_or_corrupt_data() -> Result<(), IrError> {
    let mut fixture = Fixture::new()?;
    fixture.metadata.blobs[1].byte_offset = 0;
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::BlobOverlap)
    ));
    fixture.metadata.blobs[1].byte_offset = 1;
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::BlobMisaligned)
    ));
    fixture.metadata.blobs[1].byte_offset = 112;
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::InvalidPadding)
    ));
    fixture.metadata.blobs[1].byte_offset = 96;
    fixture.metadata.blobs[1].element_count = 23;
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::ElementCountMismatch)
    ));
    fixture.metadata.blobs[1].element_count = 24;
    fixture.blobs[1][12..16].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::InvalidPostUniforms(_))
    ));
    fixture.blobs[1][12..16].copy_from_slice(&0_f32.to_le_bytes());
    fixture.blobs[1][92..96].copy_from_slice(&(-0_f32).to_le_bytes());
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::InvalidPostUniforms(_))
    ));
    Ok(())
}

#[test]
fn caller_limits_are_preserved_for_dump_and_reencode() -> Result<(), IrError> {
    let (mut metadata, mut blobs) = IrFixture::parts()?;
    metadata.resources.clear();
    metadata.header.render_target.width = 20_000;
    for blob in &mut blobs {
        blob[..4].copy_from_slice(&20_000_f32.to_le_bytes());
    }
    let limits = DecodeLimits {
        max_dimension: 20_000,
        max_resource_references: 0,
        ..DecodeLimits::default()
    };
    let borrowed = blobs.iter().map(Vec::as_slice).collect::<Vec<_>>();
    let bytes = FplnCodec::encode(metadata, &borrowed, &limits)?;
    assert!(FplnCodec::decode(bytes.clone(), &DecodeLimits::default()).is_err());
    let decoded = FplnCodec::decode(bytes.clone(), &limits)?;
    assert!(!decoded.metadata_json(&limits)?.is_empty());
    assert_eq!(decoded.reencode(&limits)?, bytes);
    assert!(
        DecodeLimits {
            max_metadata_bytes: 33,
            max_container_bytes: 32,
            ..limits
        }
        .validate()
        .is_err()
    );
    Ok(())
}

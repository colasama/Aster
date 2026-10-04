use crate::{BinaryRationalTime, DecodeLimits, FplnCodec, FrameRate, FrameTime, IrError};

use super::Fixture;

#[test]
fn exact_times_rates_and_time_overflow_roundtrip_as_owned_container_bytes() -> Result<(), IrError> {
    for value in [
        0.0,
        -0.0,
        0.1,
        -1.0 / 3.0,
        f64::from_bits(1),
        f64::MAX,
        -f64::MAX,
    ] {
        let mut fixture = Fixture::new()?;
        fixture.metadata.header.time = FrameTime::from_f64(value)?;
        fixture.metadata.header.frame_rate = FrameRate::BinaryRatio {
            numerator: BinaryRationalTime::from_positive_f64(29.97)?,
            denominator: BinaryRationalTime::from_positive_f64(1.0)?,
        };
        for blob in &mut fixture.blobs {
            blob[8..12].copy_from_slice(&(value as f32).to_le_bytes());
        }
        let bytes = fixture.encode()?;
        let decoded = FplnCodec::decode(bytes.clone(), &DecodeLimits::default())?;
        assert_eq!(decoded.metadata.header, fixture.metadata.header);
        assert_eq!(
            decoded.metadata.header.time.to_f64()?.to_bits(),
            value.to_bits()
        );
        assert_eq!(&decoded.blob(0)?[8..12], &(value as f32).to_le_bytes());
        assert_eq!(decoded.reencode(&DecodeLimits::default())?, bytes);
    }
    Ok(())
}

#[test]
fn nonfinite_uniform_exception_is_limited_to_matching_time_overflow() -> Result<(), IrError> {
    for (header, lane, value) in [
        (f64::MAX, 2, f32::NEG_INFINITY),
        (-f64::MAX, 2, f32::INFINITY),
        (1.0, 2, f32::INFINITY),
        (f64::MAX, 2, f32::NAN),
        (f64::MAX, 3, f32::INFINITY),
        (-f64::MAX, 3, f32::NEG_INFINITY),
    ] {
        let mut fixture = Fixture::new()?;
        fixture.metadata.header.time = FrameTime::from_f64(header)?;
        fixture.blobs[0][lane * 4..lane * 4 + 4].copy_from_slice(&value.to_le_bytes());
        assert!(matches!(
            fixture.encode(),
            Err(IrError::InvalidPostUniforms(_))
        ));
        assert!(matches!(
            FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
            Err(IrError::InvalidPostUniforms(_))
        ));
    }
    let mut finite_slices = Fixture::new()?;
    finite_slices.blobs[1][8..12].copy_from_slice(&7.25_f32.to_le_bytes());
    let decoded = FplnCodec::decode(finite_slices.encode()?, &DecodeLimits::default())?;
    assert_ne!(&decoded.blob(0)?[8..12], &decoded.blob(1)?[8..12]);
    Ok(())
}

#[test]
fn snapshot_scope_is_required_and_bounded_by_utf8_bytes() -> Result<(), IrError> {
    for invalid in [
        String::new(),
        "scope\0suffix".to_owned(),
        "x".repeat(257),
        "🦀".repeat(65),
    ] {
        let mut fixture = Fixture::new()?;
        fixture.metadata.header.snapshot_scope = invalid;
        assert!(matches!(fixture.encode(), Err(IrError::InvalidHeader(_))));
        assert!(matches!(
            FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
            Err(IrError::InvalidHeader(_))
        ));
    }
    let mut fixture = Fixture::new()?;
    fixture.metadata.header.snapshot_scope = "🦀".repeat(64);
    assert!(FplnCodec::decode(fixture.encode()?, &DecodeLimits::default()).is_ok());
    let json = crate::canonical::CanonicalJson::encode(&fixture.metadata)?;
    let mut value: serde_json::Value =
        serde_json::from_slice(&json).map_err(|error| IrError::InvalidJson(error.to_string()))?;
    let header = value["header"]
        .as_object_mut()
        .ok_or_else(|| IrError::InvalidJson("missing header".to_owned()))?;
    header.remove("snapshot_scope");
    assert!(matches!(
        FplnCodec::decode(
            Fixture::unchecked_json(
                &crate::canonical::CanonicalJson::encode(&value)?,
                &fixture.blobs
            )?,
            &DecodeLimits::default()
        ),
        Err(IrError::InvalidJson(_))
    ));
    Ok(())
}

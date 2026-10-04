use crate::{
    CompositionIdentity, DecodeLimits, FplnCodec, FramePlanSchema, IrError,
    Utf16CompositionIdentity,
};

use super::Fixture;

#[test]
fn composition_identity_preserves_unicode_and_unpaired_utf16_without_field_limits()
-> Result<(), IrError> {
    let mut identities = [
        "\0".to_owned(),
        "x".repeat(257),
        "中".repeat(100),
        "\r\n🦀".to_owned(),
    ]
    .into_iter()
    .map(CompositionIdentity::Unicode)
    .collect::<Vec<_>>();
    for utf16_units in [
        vec![0xd800],
        vec![0xdc00],
        vec![0xd83d, 0xde80, 0xd800, 0, 65],
    ] {
        identities.push(CompositionIdentity::Utf16(Utf16CompositionIdentity {
            utf16_units,
        }));
    }
    for identity in identities {
        let mut fixture = Fixture::new()?;
        fixture.metadata.header.composition_id = identity.clone();
        let bytes = fixture.encode()?;
        let decoded = FplnCodec::decode(bytes.clone(), &DecodeLimits::default())?;
        assert_eq!(decoded.metadata.header.composition_id, identity);
        assert_eq!(decoded.reencode(&DecodeLimits::default())?, bytes);
    }
    Ok(())
}

#[test]
fn composition_identity_rejects_empty_values_and_noncanonical_alternate_encodings()
-> Result<(), IrError> {
    let mut invalid = vec![CompositionIdentity::Unicode(String::new())];
    for utf16_units in [vec![], vec![0], vec![65], vec![0xd83d, 0xde80]] {
        invalid.push(CompositionIdentity::Utf16(Utf16CompositionIdentity {
            utf16_units,
        }));
    }
    for identity in invalid {
        let mut fixture = Fixture::new()?;
        fixture.metadata.header.composition_id = identity;
        assert!(matches!(fixture.encode(), Err(IrError::InvalidHeader(_))));
        assert!(matches!(
            FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
            Err(IrError::InvalidHeader(_))
        ));
    }
    for json in [
        r#"{"utf16_units":[55296],"extra":1}"#,
        r#"{"utf16_units":[65536]}"#,
        r#"{"utf16_units":[-1]}"#,
        r#"{"utf16_units":[1.5]}"#,
        r#"{"units":[55296]}"#,
    ] {
        assert!(serde_json::from_str::<CompositionIdentity>(json).is_err());
    }
    Ok(())
}

#[test]
fn identity_transport_keeps_the_metadata_budget_and_precise_schema() -> Result<(), IrError> {
    let mut fixture = Fixture::new()?;
    fixture.metadata.header.composition_id =
        CompositionIdentity::Unicode("x".repeat(DecodeLimits::default().max_metadata_bytes));
    assert!(matches!(fixture.encode(), Err(IrError::LimitExceeded(_))));
    assert!(matches!(
        FplnCodec::decode(fixture.unchecked_metadata()?, &DecodeLimits::default()),
        Err(IrError::LimitExceeded(_))
    ));
    let schema: serde_json::Value = serde_json::from_slice(&FramePlanSchema::emit()?)
        .map_err(|error| IrError::InvalidJson(error.to_string()))?;
    let identity = &schema["$defs"]["CompositionIdentity"]["anyOf"][0];
    assert_eq!(identity["type"], "string");
    assert_eq!(identity["minLength"], 1);
    assert!(identity.get("maxLength").is_none());
    let alternative = &schema["$defs"]["Utf16CompositionIdentity"];
    assert_eq!(alternative["additionalProperties"], false);
    assert_eq!(alternative["properties"]["utf16_units"]["minItems"], 1);
    assert_eq!(
        alternative["properties"]["utf16_units"]["items"]["minimum"],
        0
    );
    assert_eq!(
        alternative["properties"]["utf16_units"]["items"]["maximum"],
        65535
    );
    Ok(())
}

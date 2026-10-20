use super::{RuntimeProjectDocument, RuntimeProjectLimits};
use serde_json::Value;

#[test]
fn runtime_upgrade_preserves_authored_material_order_and_unknown_fields()
-> Result<(), Box<dyn std::error::Error>> {
    let input = br#"{"schemaVersion":9.0,"activeCompositionId":"c","compositions":[{"id":"c","layers":[{"id":"l","kind":"shape","size":[32,18],"material":{"z":1,"2":2,"a":3,"z":4},"transform":{"anchor":null},"vendor":{"b":null,"a":[1,2]}}]}]}"#;
    let normalized = RuntimeProjectDocument::from_slice(input, &RuntimeProjectLimits::default())?;
    assert_eq!(normalized.source_version(), 9);
    let bytes = normalized.encode()?;
    let text = std::str::from_utf8(&bytes)?;
    assert!(text.contains(r#""material":{"2":2,"z":4,"a":3}"#));
    assert!(text.contains(r#""vendor":{"b":null,"a":[1,2]}"#));
    let document: Value = serde_json::from_slice(&bytes)?;
    assert_eq!(document["schemaVersion"], 10);
    assert_eq!(
        document["compositions"][0]["layers"][0]["transform"]["anchor"][0]["value"].as_f64(),
        Some(16.0)
    );
    assert_eq!(
        document["compositions"][0]["layers"][0]["transform"]["anchor"][1]["value"].as_f64(),
        Some(9.0)
    );
    assert!(std::str::from_utf8(input)?.contains(r#""anchor":null"#));
    Ok(())
}
#[test]
fn runtime_admission_rejects_expansion_and_collection_limits()
-> Result<(), Box<dyn std::error::Error>> {
    let input = br#"{"schemaVersion":9,"activeCompositionId":"c","compositions":[{"id":"c","layers":[{"id":"l","kind":"shape","size":[32,18],"transform":{}}]}]}"#;
    let defaults = RuntimeProjectLimits::default();
    for limits in [
        RuntimeProjectLimits {
            max_input_bytes: input.len() - 1,
            ..defaults.clone()
        },
        RuntimeProjectLimits {
            max_compositions: 0,
            ..defaults.clone()
        },
        RuntimeProjectLimits {
            max_project_layers: 0,
            ..defaults.clone()
        },
        RuntimeProjectLimits {
            max_output_bytes: 0,
            ..defaults.clone()
        },
    ] {
        assert!(RuntimeProjectDocument::from_slice(input, &limits).is_err());
    }
    let document = RuntimeProjectDocument::from_slice(
        input,
        &RuntimeProjectLimits {
            max_output_bytes: input.len(),
            ..defaults
        },
    )?;
    assert!(document.encode().is_err());
    Ok(())
}

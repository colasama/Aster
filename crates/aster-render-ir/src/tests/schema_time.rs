use crate::{FramePlanSchema, IrError, RationalFrameRate, RationalTime};

#[test]
fn rational_wire_values_reject_quantization_normalization_and_unsafe_ranges() -> Result<(), IrError>
{
    let rate = RationalFrameRate {
        numerator: 24000,
        denominator: 1001,
    };
    assert_eq!(
        rate.time_at_frame(-240)?,
        RationalTime {
            value: -1001,
            scale: 100
        }
    );
    assert_eq!(rate.time_at_frame(0)?, RationalTime { value: 0, scale: 1 });
    assert!(RationalTime { value: 0, scale: 2 }.validate().is_err());
    assert!(RationalTime { value: 1, scale: 0 }.validate().is_err());
    assert!(
        RationalTime {
            value: -9_007_199_254_740_992,
            scale: 1
        }
        .validate()
        .is_err()
    );
    assert!(
        RationalFrameRate {
            numerator: 48000,
            denominator: 2002
        }
        .validate()
        .is_err()
    );
    assert!(
        RationalFrameRate {
            numerator: 1,
            denominator: u32::MAX
        }
        .time_at_frame(9_007_199_254_740_991)
        .is_err()
    );
    assert!(
        RationalFrameRate {
            numerator: 30000,
            denominator: 1001
        }
        .validate()
        .is_ok()
    );
    Ok(())
}

#[test]
fn generated_schema_is_deterministic_and_cannot_claim_a_complete_plan() -> Result<(), IrError> {
    let first = FramePlanSchema::emit()?;
    assert_eq!(first, FramePlanSchema::emit()?);
    let schema: serde_json::Value =
        serde_json::from_slice(&first).map_err(|error| IrError::InvalidJson(error.to_string()))?;
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(
        schema["properties"]["renderer_plan_complete"]["const"],
        false
    );
    assert_eq!(schema["properties"]["plan_version"]["const"], 1);
    let times = schema["$defs"]["FrameTime"]["oneOf"]
        .as_array()
        .ok_or_else(|| IrError::InvalidJson("missing time variants".to_owned()))?;
    assert_eq!(times.len(), 2);
    assert!(
        times
            .iter()
            .all(|variant| variant["additionalProperties"] == false)
    );
    let rational = times
        .iter()
        .find(|variant| variant["properties"]["kind"]["const"] == "rational")
        .ok_or_else(|| IrError::InvalidJson("missing rational variant".to_owned()))?;
    assert_eq!(
        rational["properties"]["value"]["maximum"],
        9_007_199_254_740_991_u64
    );
    let rates = schema["$defs"]["FrameRate"]["oneOf"]
        .as_array()
        .ok_or_else(|| IrError::InvalidJson("missing frame rate variants".to_owned()))?;
    assert_eq!(rates.len(), 2);
    assert!(
        rates
            .iter()
            .all(|variant| variant["additionalProperties"] == false)
    );
    let rate_scalar = &schema["$defs"]["BinaryRationalTime"]["oneOf"][0];
    assert_eq!(rate_scalar["properties"]["negative"]["const"], false);
    assert_eq!(rate_scalar["properties"]["significand"]["minimum"], 1);
    assert_eq!(
        schema["$defs"]["FrameHeaderSlice"]["properties"]["snapshot_scope"]["maxLength"],
        256
    );
    assert_eq!(
        schema["$defs"]["PutResource"]["additionalProperties"],
        false
    );
    assert_eq!(
        schema["$defs"]["BufferResourceDescriptor"]["properties"]["byte_length"]["minimum"],
        1
    );
    let variants = schema["$defs"]["ResourceMessage"]["oneOf"]
        .as_array()
        .ok_or_else(|| IrError::InvalidJson("missing resource message variants".to_owned()))?;
    assert_eq!(variants.len(), 2);
    assert!(
        variants
            .iter()
            .all(|variant| variant["additionalProperties"] == false)
    );
    assert!(
        variants
            .iter()
            .any(|variant| variant["properties"]["type"]["const"] == "put_resource")
    );
    assert!(
        variants
            .iter()
            .any(|variant| variant["properties"]["type"]["const"] == "evict_resource")
    );
    Ok(())
}

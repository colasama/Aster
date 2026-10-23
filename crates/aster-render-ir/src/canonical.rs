use serde::Serialize;

use crate::IrError;

pub(crate) struct CanonicalJson;

impl CanonicalJson {
    pub(crate) fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, IrError> {
        let mut value =
            serde_json::to_value(value).map_err(|error| IrError::InvalidJson(error.to_string()))?;
        // Default maps are already ordered. Also canonicalize nested maps when dependency
        // feature unification enables insertion order, without building a second tree per object.
        value.sort_all_objects();
        serde_json::to_vec(&value).map_err(|error| IrError::InvalidJson(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize)]
    struct Nested {
        z: String,
        a: f64,
    }

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Vector {
        z: u64,
        negative_zero: f64,
        b: Option<bool>,
        a: Vec<Nested>,
    }

    #[test]
    fn canonical_bytes_preserve_nested_order_escaping_and_numeric_forms() -> Result<(), IrError> {
        let value = Vector {
            z: u64::MAX,
            negative_zero: -0.0,
            b: None,
            a: vec![Nested {
                z: "line\n\u{1}雪\"".into(),
                a: 1.5,
            }],
        };
        let expected = r#"{"a":[{"a":1.5,"z":"line\n\u0001雪\""}],"b":null,"negativeZero":-0.0,"z":18446744073709551615}"#;
        assert_eq!(CanonicalJson::encode(&value)?, expected.as_bytes());
        Ok(())
    }
}

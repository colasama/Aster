use serde_json::Value;

pub(crate) struct Comparison;
impl Comparison {
    pub fn compare(actual: &Value, expected: &Value, context: &str) {
        match (actual, expected) {
            (Value::Number(actual), Value::Number(expected)) => {
                let (Some(actual), Some(expected)) = (actual.as_f64(), expected.as_f64()) else {
                    panic!("invalid numeric result")
                };
                assert!(actual.is_finite() && expected.is_finite());
                assert!(
                    (actual - expected).abs() <= 1e-6 + expected.abs() * 1e-5,
                    "{context}: native={actual}, TS={expected}"
                );
            }
            (Value::Array(actual), Value::Array(expected)) => {
                assert_eq!(actual.len(), expected.len(), "{context} array length");
                for (index, (actual, expected)) in actual.iter().zip(expected).enumerate() {
                    Self::compare(actual, expected, &format!("{context}[{index}]"));
                }
            }
            (Value::Object(actual), Value::Object(expected)) => {
                assert_eq!(actual.len(), expected.len(), "{context} object fields");
                for (key, expected) in expected {
                    let actual = actual.get(key).expect("missing scene field");
                    Self::compare(actual, expected, &format!("{context}.{key}"));
                }
            }
            _ => assert_eq!(actual, expected, "{context}"),
        }
    }
}

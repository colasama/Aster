use super::PlanDifference;
use serde_json::Value;

pub(super) struct Structure;
impl Structure {
    pub fn first(a: &Value, b: &Value, path: &str) -> Option<PlanDifference> {
        if a == b {
            return None;
        }
        match (a, b) {
            (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                for (i, (a, b)) in a.iter().zip(b).enumerate() {
                    if let Some(d) = Self::first(a, b, &format!("{path}/{i}")) {
                        return Some(d);
                    }
                }
                None
            }
            (Value::Object(a), Value::Object(b)) if a.keys().eq(b.keys()) => {
                for (key, a) in a {
                    if let Some(b) = b.get(key)
                        && let Some(d) = Self::first(
                            a,
                            b,
                            &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                        )
                    {
                        return Some(d);
                    }
                }
                None
            }
            _ => Some(PlanDifference {
                path: path.into(),
                kind: "structure".into(),
                expected: a.to_string().chars().take(240).collect(),
                actual: b.to_string().chars().take(240).collect(),
            }),
        }
    }
}

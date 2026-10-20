use aster_project::{RuntimeProjectDocument, RuntimeProjectLimits};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};

#[derive(Deserialize)]
struct Input {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    input: Option<String>,
    project: Option<Input>,
    expected: Option<Value>,
    expected_sha256: Option<String>,
    rejected: bool,
}
#[derive(Deserialize)]
struct Oracle {
    schema_version: u32,
    sources: Vec<Input>,
    cases: Vec<Case>,
    projects: usize,
}
struct Comparison;
impl Input {
    fn read(&self, root: &std::path::Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let bytes = fs::read(root.join(&self.path))?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            self.sha256,
            "input changed: {}",
            self.path.display()
        );
        Ok(bytes)
    }
}
impl Comparison {
    fn compare(expected: &Value, actual: &Value, context: &str) {
        match (expected, actual) {
            (Value::Number(a), Value::Number(b)) => {
                let a = a.as_f64().expect("finite oracle number");
                let b = b.as_f64().expect("finite native number");
                assert!(
                    (a - b).abs() <= a.abs().max(b.abs()).max(1.0) * 1e-12,
                    "{context}: {a} differs from {b}"
                );
            }
            (Value::Array(a), Value::Array(b)) => {
                assert_eq!(a.len(), b.len(), "{context}");
                for (i, (a, b)) in a.iter().zip(b).enumerate() {
                    Self::compare(a, b, &format!("{context}/{i}"));
                }
            }
            (Value::Object(a), Value::Object(b)) => {
                assert_eq!(
                    a.keys().collect::<Vec<_>>(),
                    b.keys().collect::<Vec<_>>(),
                    "{context}"
                );
                for (key, a) in a {
                    Self::compare(a, &b[key], &format!("{context}/{key}"));
                }
            }
            _ => assert_eq!(expected, actual, "{context}"),
        }
    }
    fn canonical(value: &Value, output: &mut String) -> Result<(), serde_json::Error> {
        match value {
            Value::Number(number) => {
                output.push_str(ryu_js::Buffer::new().format(number.as_f64().unwrap_or(f64::NAN)))
            }
            Value::Array(values) => {
                output.push('[');
                for (i, v) in values.iter().enumerate() {
                    if i > 0 {
                        output.push(',');
                    }
                    Self::canonical(v, output)?;
                }
                output.push(']');
            }
            Value::Object(values) => {
                output.push('{');
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
                for (i, key) in keys.into_iter().enumerate() {
                    if i > 0 {
                        output.push(',');
                    }
                    output.push_str(&serde_json::to_string(key)?);
                    output.push(':');
                    Self::canonical(&values[key], output)?;
                }
                output.push('}');
            }
            _ => output.push_str(&serde_json::to_string(value)?),
        }
        Ok(())
    }
}
#[test]
#[ignore = "requires independently captured TS runtime upgrades and corpus inputs"]
fn runtime_upgrades_match_ts_oracle() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let file = std::env::var_os("ASTER_RUNTIME_PROJECT_ORACLE")
        .ok_or("runtime project oracle is required")?;
    let oracle: Oracle = serde_json::from_slice(&fs::read(file)?)?;
    assert_eq!(oracle.schema_version, 1);
    assert!(oracle.projects > 0 && oracle.cases.len() > oracle.projects);
    for source in &oracle.sources {
        source.read(&root)?;
    }
    let mut projects = 0;
    for case in oracle.cases {
        let bytes = match (&case.project, &case.input) {
            (Some(input), None) => {
                projects += 1;
                input.read(&root)?
            }
            (None, Some(input)) => input.as_bytes().to_vec(),
            _ => return Err("ambiguous runtime project input".into()),
        };
        let upgraded = RuntimeProjectDocument::from_slice(&bytes, &RuntimeProjectLimits::default());
        if case.rejected {
            assert!(upgraded.is_err(), "{}: invalid project accepted", case.id);
            continue;
        }
        let actual: Value = serde_json::from_slice(&upgraded?.encode()?)?;
        if let Some(expected) = case.expected {
            Comparison::compare(&expected, &actual, &case.id);
        } else if let Some(expected) = case.expected_sha256 {
            let mut output = String::new();
            Comparison::canonical(&actual, &mut output)?;
            assert_eq!(
                format!("{:x}", Sha256::digest(output.as_bytes())),
                expected,
                "{}",
                case.id
            );
        } else {
            return Err("runtime expected result missing".into());
        }
    }
    assert_eq!(projects, oracle.projects);
    Ok(())
}

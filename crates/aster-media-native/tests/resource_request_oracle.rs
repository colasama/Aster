use aster_eval::{
    EvaluationLimits, ExpressionLimits, FramePlanRequest, ResourceRequestContext, SceneLimits,
    SceneProject, SurfaceLimits,
};
use aster_project::{RuntimeProjectDocument, RuntimeProjectLimits};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
struct Proof {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Input {
    sources: Vec<Proof>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    project: Option<Proof>,
    inline: Option<Value>,
    layouts: Value,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    frame: FramePlanRequest,
    context: Value,
    expected: Value,
}

impl Proof {
    fn read(&self, root: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let bytes = fs::read(root.join(&self.path))?;
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), self.sha256);
        Ok(bytes)
    }
}
impl Sample {
    fn compare(actual: &Value, expected: &Value, address: &str) {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => assert_eq!(a.as_f64(), b.as_f64(), "{address}"),
            (Value::Array(a), Value::Array(b)) => {
                assert_eq!(a.len(), b.len(), "{address}");
                for (i, (a, b)) in a.iter().zip(b).enumerate() {
                    Self::compare(a, b, &format!("{address}[{i}]"));
                }
            }
            (Value::Object(a), Value::Object(b)) => {
                assert_eq!(a.len(), b.len(), "{address}");
                for (key, b) in b {
                    let Some(a) = a.get(key) else {
                        panic!("{address}.{key} absent")
                    };
                    Self::compare(a, b, &format!("{address}.{key}"));
                }
            }
            _ => assert_eq!(actual, expected, "{address}"),
        }
    }
}
#[test]
#[ignore = "requires independent TS project resource preparation oracle"]
fn native_project_resource_requests_match_ts() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let input: Input =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_RESOURCE_REQUEST_ORACLE")?)?)?;
    for proof in input.sources {
        proof.read(&root)?;
    }
    for case in input.cases {
        let bytes = match (case.project, case.inline) {
            (Some(p), None) => p.read(&root)?,
            (None, Some(v)) => serde_json::to_vec(&v)?,
            _ => return Err("exactly one project input required".into()),
        };
        let runtime = RuntimeProjectDocument::from_slice(&bytes, &RuntimeProjectLimits::default())?
            .encode()?;
        let scene = SceneProject::compile_document(
            &runtime,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        let layouts = case.layouts;
        for mut sample in case.samples {
            sample
                .context
                .as_object_mut()
                .ok_or("context must be object")?
                .insert("layouts".into(), layouts.clone());
            let context: ResourceRequestContext = serde_json::from_value(sample.context)?;
            let actual = scene.project_resource_requests(
                &sample.frame,
                &context,
                &SurfaceLimits::default(),
            )?;
            let mut actual = serde_json::to_value(actual)?;
            actual
                .as_object_mut()
                .ok_or("request must be object")?
                .remove("header");
            Sample::compare(
                &actual,
                &sample.expected,
                &format!("{} at {}", case.id, sample.frame.time),
            );
        }
    }
    Ok(())
}

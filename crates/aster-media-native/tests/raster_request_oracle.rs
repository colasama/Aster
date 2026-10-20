use aster_eval::{
    EvaluationLimits, ExpressionLimits, RetainedRasterContext, SceneLimits, SceneProject,
    TextExposureRequest, TextLayouts,
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
    project: Proof,
    layouts: TextLayouts,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    request: Request,
    expected: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    composition_id: String,
    time: f64,
    locale: String,
    context: RetainedRasterContext,
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

impl Proof {
    fn read(&self, root: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let bytes = fs::read(root.join(&self.path))?;
        assert_eq!(format!("{:x}", Sha256::digest(&bytes)), self.sha256);
        Ok(bytes)
    }
}

#[test]
#[ignore = "requires independent TS retained raster request oracle"]
fn native_retained_raster_requests_match_ts() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let input: Input =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_RASTER_REQUEST_ORACLE")?)?)?;
    for proof in &input.sources {
        proof.read(&root)?;
    }
    for case in input.cases {
        let runtime = RuntimeProjectDocument::from_slice(
            &case.project.read(&root)?,
            &RuntimeProjectLimits::default(),
        )?
        .encode()?;
        let scene = SceneProject::compile_document(
            &runtime,
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for sample in case.samples {
            let request = sample.request;
            let exposure = scene.text_exposure_frame(
                &TextExposureRequest {
                    composition_id: request.composition_id.clone(),
                    time: request.time,
                    resolution_scale: request.context.resolution_scale,
                    locale: request.locale,
                },
                &case.layouts,
            )?;
            let requests = scene.retained_raster_requests(
                &request.composition_id,
                &exposure.render_scene_layers,
                &request.context,
                &exposure.plans,
            )?;
            let actual = serde_json::to_value(requests)?;
            Sample::compare(
                &actual,
                &sample.expected,
                &format!("{} at {}", case.id, request.time),
            );
        }
    }
    Ok(())
}

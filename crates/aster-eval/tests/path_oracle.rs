mod support;
use aster_eval::{
    EvaluationLimits, ExpressionLimits, PathLimits, PathTessellator, PathTrack, Point2,
};
use aster_types::editor::Shape;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    cases: Vec<Input>,
    polylines: Vec<Polyline>,
}
#[derive(Deserialize)]
struct Input {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Case {
    shape: Shape,
    expression: Option<String>,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    time: f64,
    size: [f64; 2],
    evaluated: Value,
    flattened: Value,
    geometry: Value,
}
#[derive(Deserialize)]
struct Polyline {
    points: Vec<Point2>,
    closed: bool,
    trims: Vec<Trim>,
    strokes: Vec<Stroke>,
    triangles: Value,
}
#[derive(Deserialize)]
struct Trim {
    start: f64,
    end: f64,
    offset: f64,
    value: Value,
}
#[derive(Deserialize)]
struct Stroke {
    width: f64,
    join: String,
    cap: String,
    value: Value,
}

impl Input {
    fn read(&self, root: &Path) -> Result<Vec<u8>, Box<dyn Error>> {
        let bytes = fs::read(root.join(&self.path))?;
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            self.sha256,
            "{}",
            self.path.display()
        );
        Ok(bytes)
    }
}

#[test]
#[ignore = "requires independently captured TS vector path oracle"]
fn native_paths_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle = serde_json::from_slice(&fs::read(std::env::var("ASTER_PATH_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 200);
    for source in &oracle.sources {
        source.read(&root)?;
    }
    let limits = PathLimits::default();
    for (index, input) in oracle.cases.iter().enumerate() {
        let case: Case = serde_json::from_slice(&input.read(&root)?)?;
        let track = PathTrack::compile(
            &case.shape,
            case.expression.as_deref(),
            &limits,
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for sample in case.samples.iter().rev() {
            let evaluated = track.evaluate(sample.time)?.ok_or("missing path")?;
            Comparison::compare(
                &serde_json::to_value(&evaluated)?,
                &sample.evaluated,
                &format!("path {index} at {}", sample.time),
            );
            Comparison::compare(
                &serde_json::to_value(PathTessellator::new(&limits).flatten(&evaluated, 0.002)?)?,
                &sample.flattened,
                "flattened path",
            );
            Comparison::compare(
                &serde_json::to_value(PathTessellator::new(&limits).geometry(
                    &evaluated,
                    &case.shape,
                    sample.size,
                )?)?,
                &sample.geometry,
                &format!("geometry {index} at {}", sample.time),
            );
        }
    }
    for line in oracle.polylines {
        Comparison::compare(
            &serde_json::to_value(PathTessellator::new(&limits).triangulate(&line.points)?)?,
            &line.triangles,
            "triangulation",
        );
        for trim in line.trims {
            Comparison::compare(
                &serde_json::to_value(PathTessellator::new(&limits).trim(
                    &line.points,
                    line.closed,
                    trim.start,
                    trim.end,
                    trim.offset,
                )?)?,
                &trim.value,
                "polyline trim",
            );
        }
        for stroke in line.strokes {
            Comparison::compare(
                &serde_json::to_value(PathTessellator::new(&limits).stroke(
                    &line.points,
                    stroke.width,
                    line.closed,
                    &stroke.join,
                    &stroke.cap,
                )?)?,
                &stroke.value,
                "polyline stroke",
            );
        }
    }
    Ok(())
}

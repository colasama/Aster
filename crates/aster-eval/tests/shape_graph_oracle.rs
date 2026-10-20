mod support;
use aster_eval::{EvaluationLimits, PathLimits, ShapeGraphLimits, ShapeGraphTrack};
use aster_types::editor::Layer;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf, sync::Arc};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct Case {
    layer: Layer,
    error: bool,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    time: f64,
    shapes: Value,
    masks: Value,
}

#[test]
#[ignore = "requires independently captured TS shape graph oracle"]
fn native_shape_graphs_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_SHAPE_GRAPH_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.cases.len() >= 15);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (i, case) in oracle.cases.iter().enumerate() {
        let graph = ShapeGraphTrack::compile(
            case.layer
                .shape_graph
                .value()
                .ok_or("missing shape graph")?,
            &ShapeGraphLimits::default(),
            &PathLimits::default(),
            &EvaluationLimits::default(),
        );
        assert_eq!(
            graph.is_err(),
            case.error,
            "graph {i}: {:?}",
            graph.as_ref().err()
        );
        if case.error {
            continue;
        }
        let graph = graph?;
        for sample in case.samples.iter().rev() {
            let shapes = graph.evaluate(sample.time)?;
            let masks = graph.masks(&case.layer);
            Comparison::compare(
                &serde_json::to_value(&shapes)?,
                &sample.shapes,
                &format!("graph {i} at {}", sample.time),
            );
            Comparison::compare(
                &serde_json::to_value(&masks)?,
                &sample.masks,
                "resolved path masks",
            );
            for shape in &shapes {
                for mask in &masks {
                    if shape.path_id == mask.path_id {
                        assert!(Arc::ptr_eq(&shape.path, &mask.path));
                    }
                }
            }
        }
    }
    Ok(())
}

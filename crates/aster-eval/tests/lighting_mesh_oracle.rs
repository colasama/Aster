mod support;

use aster_eval::{
    CameraProjector, EvaluatedCamera, EvaluatedTransform, GeometryLimits, MeshGeometry,
    SceneLighting,
};
use aster_types::editor::Layer;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Source>,
    lighting: Vec<Lighting>,
    meshes: Vec<MeshCase>,
}
#[derive(Deserialize)]
struct Source {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
struct LayerInput {
    layer: Layer,
    transform: EvaluatedTransform,
}
#[derive(Deserialize)]
struct Lighting {
    size: [f64; 2],
    layers: Vec<LayerInput>,
    shadows: bool,
    camera: Option<[f64; 3]>,
    data: Vec<f32>,
    shadow_size: u32,
}
#[derive(Deserialize)]
struct MeshCase {
    layer: Layer,
    size: [f64; 2],
    samples: Vec<MeshSample>,
}
#[derive(Deserialize)]
struct MeshSample {
    time: f64,
    transform: EvaluatedTransform,
    camera: EvaluatedCamera,
    data: Vec<f32>,
    vertex_count: usize,
}

#[test]
#[ignore = "requires independently captured current-source TS lighting and mesh oracle"]
fn native_lighting_and_mesh_match_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_LIGHTING_MESH_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    assert!(oracle.lighting.len() >= 21 && oracle.meshes.len() >= 36);
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (i, case) in oracle.lighting.iter().enumerate() {
        let actual = SceneLighting::evaluate(
            case.layers.iter().map(|r| (&r.layer, &r.transform)),
            case.size,
            case.shadows,
            case.camera,
        )?;
        assert_eq!(actual.shadow_map_size, case.shadow_size);
        Comparison::compare(
            &serde_json::to_value(actual.data.as_slice())?,
            &serde_json::to_value(&case.data)?,
            &format!("lighting {i}"),
        );
        // Selector/count lanes are structural integers, never float-tolerant.
        for lane in [11, 14, 35, 47, 63, 79, 95, 111, 127, 143] {
            assert_eq!(actual.data[lane], case.data[lane]);
        }
    }
    for (i, case) in oracle.meshes.iter().enumerate() {
        let geometry = MeshGeometry::compile(case.layer.mesh.value(), &GeometryLimits::default())?;
        for sample in case.samples.iter().rev() {
            let camera =
                CameraProjector::new(&sample.camera.pose, &sample.camera.projection, case.size);
            let actual = geometry.evaluate(&case.layer, &sample.transform, case.size, &camera)?;
            assert_eq!(actual.len(), sample.vertex_count * 40);
            Comparison::compare(
                &serde_json::to_value(&actual)?,
                &serde_json::to_value(&sample.data)?,
                &format!("mesh {i} at {}", sample.time),
            );
            for (a, b) in actual.chunks_exact(40).zip(sample.data.chunks_exact(40)) {
                for lane in [9, 16, 26, 27, 32, 39] {
                    assert_eq!(a[lane], b[lane]);
                }
            }
        }
    }
    Ok(())
}

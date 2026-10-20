mod support;
use aster_eval::{
    EvaluationLimits, ExpressionLimits, SceneLimits, SceneProject, TextExposureRequest, TextLayouts,
};
use aster_render_ir::FrameHeaderSlice;
use aster_types::editor::Project;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, error::Error, fs, path::PathBuf};
use support::Comparison;

#[derive(Deserialize)]
struct Oracle {
    version: u32,
    sources: Vec<Input>,
    cases: Vec<Case>,
    collations: Vec<Collation>,
    #[serde(rename = "rasterPasses")]
    raster_passes: Vec<RasterPass>,
}
#[derive(Deserialize)]
struct RasterPass {
    header: FrameHeaderSlice,
    input: aster_eval::TemporalRasterPass,
    expected: Option<Plan>,
    error: bool,
}
#[derive(Deserialize)]
struct Collation {
    locale: String,
    identities: Vec<String>,
    expected: Vec<String>,
}
#[derive(Deserialize)]
struct Input {
    path: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum ProjectInput {
    Source(Input),
    Document(Project),
}
#[derive(Deserialize)]
struct Case {
    project: ProjectInput,
    layouts: TextLayouts,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    request: TextExposureRequest,
    expected: Value,
    slices: BTreeMap<String, Plan>,
}
#[derive(Deserialize)]
struct Plan {
    metadata: Value,
    blobs: Vec<Vec<u8>>,
}

#[test]
#[ignore = "requires independently captured TS text exposure oracle"]
fn native_text_exposure_matches_ts() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let oracle: Oracle =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_TEXT_EXPOSURE_ORACLE")?)?)?;
    assert_eq!(oracle.version, 1);
    for case in oracle.raster_passes {
        let actual = case.input.plan(case.header);
        assert_eq!(actual.is_err(), case.error, "temporal raster admission");
        if let Some(expected) = case.expected {
            let actual = actual?;
            assert_eq!(serde_json::to_value(actual.metadata)?, expected.metadata);
            assert_eq!(actual.blobs, expected.blobs);
        }
    }
    for case in oracle.collations {
        let collation = aster_eval::TextCollation::new(&case.locale)?;
        let mut actual = case.identities;
        actual.sort_by(|a, b| collation.compare(a, b));
        assert_eq!(actual, case.expected, "collation {}", case.locale);
    }
    for source in oracle.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(source.path))?)),
            source.sha256
        );
    }
    for (index, case) in oracle.cases.into_iter().enumerate() {
        let document = match case.project {
            ProjectInput::Document(p) => p,
            ProjectInput::Source(input) => {
                let bytes = fs::read(root.join(input.path))?;
                assert_eq!(format!("{:x}", Sha256::digest(&bytes)), input.sha256);
                serde_json::from_slice(&bytes)?
            }
        };
        let project = SceneProject::compile(
            document.clone(),
            &SceneLimits::default(),
            &EvaluationLimits::default(),
            &ExpressionLimits::default(),
        )?;
        for sample in case.samples.into_iter().rev() {
            let frame = project.text_exposure_frame(&sample.request, &case.layouts)?;
            let composition = document
                .compositions
                .iter()
                .find(|c| c.id == sample.request.composition_id)
                .ok_or("text composition")?;
            let width = composition.width.as_f64().ok_or("text width")?;
            let height = composition.height.as_f64().ok_or("text height")?;
            let prepared = project.prepare_frame_scene(
                &aster_eval::FramePlanRequest {
                    snapshot_scope: "native-text-exposure".into(),
                    project_revision: 17,
                    composition_id: composition.id.clone(),
                    time: sample.request.time,
                    target: aster_render_ir::Extent2d {
                        width: width as u32,
                        height: height as u32,
                    },
                    render_target: aster_render_ir::Extent2d {
                        width: (width * sample.request.resolution_scale) as u32,
                        height: (height * sample.request.resolution_scale) as u32,
                    },
                    anti_aliasing: aster_render_ir::AntiAliasing::Off,
                    shadows_enabled: false,
                },
                &aster_eval::FrameSceneInputs {
                    visualization: aster_eval::BufferVisualization::Beauty,
                    text_bounds: BTreeMap::new(),
                    motion_text_bounds: BTreeMap::new(),
                    text_layouts: case.layouts.clone(),
                    locale: sample.request.locale.clone(),
                },
            )?;
            Comparison::compare(
                &serde_json::to_value(&prepared.text_exposure)?,
                &sample.expected,
                "prepared text exposure",
            );
            Comparison::compare(
                &serde_json::to_value(&frame)?,
                &sample.expected,
                &format!("text exposure {index}"),
            );
            assert_eq!(frame.plans.len(), sample.slices.len());
            assert_eq!(
                Value::from(frame.sample_count),
                sample.expected["sampleCount"]
            );
            for (id, plan) in frame.plans {
                let expected = &sample.slices[&id];
                let header: FrameHeaderSlice =
                    serde_json::from_value(expected.metadata["header"].clone())?;
                let exposure = frame
                    .exposure_scene_layers
                    .iter()
                    .any(|s| s.resource_instance_id == id);
                let native = plan.plan(header, id, exposure)?;
                assert_eq!(serde_json::to_value(&native.metadata)?, expected.metadata);
                assert_eq!(native.blobs, expected.blobs, "text exposure bytes {index}");
            }
        }
    }
    Ok(())
}

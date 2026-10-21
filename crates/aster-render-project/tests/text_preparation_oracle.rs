use aster_render_ir::ResourceHash;
use aster_render_project::{
    NativeProjectDocument, NativeProjectText, ProjectRenderLimits, ProjectTextOutcome,
    ProjectTextPaint, ProjectTextRequest, TextCapability,
};
use aster_text::{FontCatalogConfig, FontDiscoveryConfig, FontFaceId, TextLayoutResult};
use clap::Parser;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    limits: ProjectRenderLimits,
}
#[derive(Deserialize)]
struct Case {
    project: PathBuf,
    project_sha256: String,
    requests: Vec<ProjectTextRequest>,
}
#[derive(Serialize)]
struct Receipt {
    project_sha256: String,
    results: Vec<Outcome>,
    invalid_request_rejected: bool,
    revision_mismatch_rejected: bool,
}
#[derive(Serialize)]
struct FontReceipt {
    face: FontFaceId,
    family: String,
    weight: f32,
    style: String,
    variations: Vec<([u8; 4], f32)>,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum Outcome {
    Native {
        request: ProjectTextRequest,
        bounds: [f64; 4],
        size: [u32; 2],
        fonts: Vec<FontReceipt>,
        layout: TextLayoutResult,
        paints: Vec<ProjectTextPaint>,
        atlas_sha256: String,
        draws: usize,
        atlas_bytes: usize,
        zero_full_layer_cpu_rasters: bool,
    },
    Retained {
        capability: TextCapability,
    },
}

#[test]
#[ignore = "requires authenticated production observations and installed corpus fonts"]
fn project_text_preparation_against_canvas() -> Result<(), Box<dyn std::error::Error>> {
    let input = PathBuf::from(std::env::var("ASTER_PROJECT_TEXT_INPUT")?);
    let output = PathBuf::from(std::env::var("ASTER_PROJECT_TEXT_OUTPUT")?);
    let mut bytes = Vec::new();
    File::open(input)?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    assert!(bytes.len() <= 64 * 1024 * 1024);
    let cases: Vec<Case> = serde_json::from_slice(&bytes)?;
    assert!(!cases.is_empty() && cases.len() <= 32);
    let mut receipts = Vec::new();
    for case in cases {
        let options = Options::try_parse_from(["text-test"])?;
        let mut document = NativeProjectDocument::open(&case.project, options.limits)?;
        assert_eq!(document.authored_sha256, case.project_sha256);
        let platform = NativeProjectText::discover_platform(
            &document,
            &FontDiscoveryConfig::default(),
            FontCatalogConfig::default(),
        )?;
        let mut text = NativeProjectText::new(&document, platform)?;
        assert!(!case.requests.is_empty() && case.requests.len() <= 4096);
        let mut invalid = case.requests[0].clone();
        invalid.resolution_scale = 0.;
        assert!(text.prepare(&document, invalid).is_err());
        let revision = document.runtime_sha256.clone();
        document.runtime_sha256 = "different-project-revision".into();
        assert!(text.prepare(&document, case.requests[0].clone()).is_err());
        document.runtime_sha256 = revision;
        let mut results = Vec::new();
        for request in case.requests {
            results.push(match text.prepare(&document, request)? {
                ProjectTextOutcome::Native(prepared) => {
                    let receipt = Outcome::Native {
                        request: prepared.request.clone(),
                        bounds: prepared.bounds,
                        size: [prepared.plan.size.width, prepared.plan.size.height],
                        fonts: prepared
                            .fonts
                            .iter()
                            .map(|f| FontReceipt {
                                face: f.face,
                                family: f.family.clone(),
                                weight: f.weight,
                                style: format!("{:?}", f.style),
                                variations: f.variations.iter().map(|(t, v)| (*t, *v)).collect(),
                            })
                            .collect(),
                        layout: prepared.layout.clone(),
                        paints: prepared.paints.clone(),
                        atlas_sha256: prepared
                            .atlas
                            .identity
                            .iter()
                            .map(|b| format!("{b:02x}"))
                            .collect(),
                        draws: prepared.plan.draws.len(),
                        atlas_bytes: prepared.atlas.bytes,
                        zero_full_layer_cpu_rasters: true,
                    };
                    // Authenticate the recipe using the same admission constructor as real frames.
                    let _input = prepared.into_input(ResourceHash("1".repeat(64)), 268_435_456)?;
                    receipt
                }
                ProjectTextOutcome::Retained(capability) => Outcome::Retained {
                    capability: *capability,
                },
            });
        }
        receipts.push(Receipt {
            project_sha256: document.authored_sha256,
            results,
            invalid_request_rejected: true,
            revision_mismatch_rejected: true,
        });
    }
    let bytes = serde_json::to_vec(&receipts)?;
    assert!(bytes.len() <= 128 * 1024 * 1024);
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = File::options().create_new(true).write(true).open(output)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(())
}

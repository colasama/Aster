use aster_eval::{FramePlanRequest, ProjectResourceRequests, ResourceRequestContext};
use aster_render_ir::{MediaSample, ResourceDescriptor, ResourceHash};
use aster_render_project::{
    NativeProjectDocument, NativeProjectText, NativeRasterProvider, ProjectRenderError,
    ProjectRenderLimits, ProjectTextRoute, RasterProviderOptions,
};
use aster_text::{FontCatalogConfig, FontDiscoveryConfig};
use aster_video::CancellationToken;
use clap::Parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
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
struct Input {
    provider: RasterProviderOptions,
    cases: Vec<Case>,
    output: PathBuf,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    project: PathBuf,
    project_sha256: String,
    context: ResourceRequestContext,
    frames: Vec<FramePlanRequest>,
    #[serde(default)]
    rejection_contains: Vec<String>,
    provider_project_sha256: Option<String>,
}
#[derive(Serialize)]
struct Pixels {
    frame: ResourceHash,
    rgba_sha256: String,
    width: u32,
    height: u32,
    bounds: [f64; 4],
}
#[derive(Serialize)]
struct Temporal {
    output: ResourceHash,
    width: u32,
    height: u32,
    samples: Vec<(ResourceHash, f64)>,
}
#[derive(Serialize)]
struct Receipt {
    requests: ProjectResourceRequests,
    retained: ProjectResourceRequests,
    retained_sha256: String,
    response_sha256: Option<String>,
    routes: Vec<ProjectTextRoute>,
    native_inputs: usize,
    bindings: BTreeMap<String, Option<ResourceHash>>,
    pixels: Vec<Pixels>,
    temporal: Vec<Temporal>,
}
#[derive(Serialize)]
struct Member {
    path: String,
    sha256: String,
}
#[derive(Serialize)]
struct CaseReceipt {
    id: String,
    authored_sha256: String,
    runtime_sha256: String,
    locale: String,
    frames: Vec<Member>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejection: Option<String>,
}

#[test]
#[ignore = "requires installed fonts and an authenticated live raster provider"]
fn complete_project_text_routing() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    File::open(std::env::var("ASTER_TEXT_ROUTING_INPUT")?)?
        .take(64 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    assert!(bytes.len() <= 64 * 1024 * 1024);
    let input: Input = serde_json::from_slice(&bytes)?;
    assert!(!input.cases.is_empty() && input.cases.len() <= 32);
    fs::create_dir_all(&input.output)?;
    let mut report = Vec::new();
    for case in input.cases {
        assert!(!case.frames.is_empty() && case.frames.len() <= 10000);
        assert!(
            case.id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        );
        let limits = Options::try_parse_from(["text-routing"])?.limits;
        let document = NativeProjectDocument::open(&case.project, limits.clone())?;
        assert_eq!(document.authored_sha256, case.project_sha256);
        let cancel = CancellationToken::default();
        let provider = NativeRasterProvider::start(
            input.provider.clone(),
            &case.project,
            case.provider_project_sha256
                .as_deref()
                .map_or(document.authored_sha256.as_str(), |value| value),
            limits.clone(),
            &cancel,
        );
        if !case.rejection_contains.is_empty() {
            assert!(case.rejection_contains.len() <= 4);
            let message = match provider {
                Err(ProjectRenderError::Invalid(message)) => message,
                Err(error) => return Err(error.into()),
                Ok(_) => return Err("invalid font/project unexpectedly admitted".into()),
            };
            for expected in &case.rejection_contains {
                assert!(
                    expected.len() >= 16 && message.contains(expected),
                    "unexpected rejection: {message}"
                );
            }
            report.push(CaseReceipt {
                id: case.id,
                authored_sha256: document.authored_sha256,
                runtime_sha256: document.runtime_sha256,
                locale: case.context.locale,
                frames: Vec::new(),
                rejection: Some(message),
            });
            continue;
        }
        assert!(case.provider_project_sha256.is_none());
        let mut provider = provider?;
        let fonts = NativeProjectText::discover_platform(
            &document,
            &FontDiscoveryConfig::default(),
            FontCatalogConfig::default(),
        )?;
        let mut text = NativeProjectText::new(&document, fonts)?;
        let mut context = case.context;
        assert_eq!(context.locale, provider.ready.locale);
        context.layouts = provider.ready.layouts.clone();
        let directory = input.output.join(&case.id);
        fs::create_dir(&directory)?;
        let mut members = Vec::new();
        for (index, frame) in case.frames.iter().enumerate() {
            let requests = document.resource_requests(frame, &context)?;
            let mut retained = None;
            let mut response_sha256 = None;
            let prepared = text.acquire(
                &document,
                &requests,
                &context,
                limits.render_project_pixel_bytes,
                |subset| {
                    retained = Some(subset.clone());
                    let response = provider.acquire(subset, &cancel)?;
                    response_sha256 = response.request_sha256.clone();
                    Ok(response)
                },
            )?;
            let retained = retained.ok_or("retained callback was skipped")?;
            let retained_sha256 = format!("{:x}", Sha256::digest(serde_json::to_vec(&retained)?));
            assert_eq!(response_sha256.as_deref(), Some(retained_sha256.as_str()));
            let mut pixels = Vec::new();
            for pixel in &prepared.rasters.pixels {
                let packet = prepared
                    .rasters
                    .resources
                    .iter()
                    .find(|r| r.request().hash == pixel.frame)
                    .ok_or("raster frame absent")?;
                let ResourceDescriptor::MediaFrame(descriptor) = &packet.request().descriptor
                else {
                    return Err("raster descriptor absent".into());
                };
                let MediaSample::Raster(sample) = &descriptor.sample else {
                    return Err("raster sample absent".into());
                };
                pixels.push(Pixels {
                    frame: pixel.frame.clone(),
                    rgba_sha256: format!("{:x}", Sha256::digest(pixel.pixels.bytes())),
                    width: descriptor.width,
                    height: descriptor.height,
                    bounds: sample.bounds()?,
                });
            }
            let receipt = Receipt {
                requests,
                retained,
                retained_sha256,
                response_sha256,
                routes: prepared.routes,
                native_inputs: prepared.native.len(),
                bindings: prepared.rasters.bindings,
                pixels,
                temporal: prepared
                    .rasters
                    .temporal
                    .into_iter()
                    .map(|p| Temporal {
                        output: p.output,
                        width: p.width,
                        height: p.height,
                        samples: p.samples.into_iter().map(|s| (s.hash, s.weight)).collect(),
                    })
                    .collect(),
            };
            let bytes = serde_json::to_vec(&receipt)?;
            let filename = format!("{index}.json");
            let mut file = File::options()
                .create_new(true)
                .write(true)
                .open(directory.join(&filename))?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            members.push(Member {
                path: format!("{}/{filename}", case.id),
                sha256: format!("{:x}", Sha256::digest(bytes)),
            });
        }
        report.push(CaseReceipt {
            id: case.id,
            authored_sha256: document.authored_sha256,
            runtime_sha256: document.runtime_sha256,
            locale: context.locale,
            frames: members,
            rejection: None,
        });
    }
    let mut file = File::options()
        .create_new(true)
        .write(true)
        .open(input.output.join("report.json"))?;
    file.write_all(&serde_json::to_vec(&report)?)?;
    file.sync_all()?;
    Ok(())
}

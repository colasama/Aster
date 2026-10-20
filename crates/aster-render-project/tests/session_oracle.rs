mod session_resources;
use aster_eval::{BufferVisualization, FramePlanRequest, ResourceRequestContext, SurfaceRequest};
use aster_media_native::{
    NativeTextureSession, ProjectMediaLimits, ProjectMediaTools, RadianceLimits, TextureLimits,
};
use aster_render_ir::{CompositionIdentity, DecodeLimits, FplnCodec, PlanComparison};
use aster_render_project::{
    NativeProjectAudio, NativeProjectDocument, NativeProjectFileMedia, NativeProjectGenerators,
    NativeProjectGpu, NativeProjectMaterials, NativeProjectSession, ProjectAudioLimits,
    ProjectFrameSettings, ProjectRasterFrame, ProjectRenderLimits,
};
use aster_renderer::{NativeOptions, NativeRenderer, SuppliedFrame};
use aster_video::CancellationToken;
use clap::Parser;
use session_resources::ReferenceResources;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    time::Duration,
};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    project: ProjectRenderLimits,
    #[command(flatten)]
    media: ProjectMediaLimits,
    #[command(flatten)]
    audio: ProjectAudioLimits,
    #[command(flatten)]
    textures: TextureLimits,
    #[command(flatten)]
    radiance: RadianceLimits,
}

#[derive(serde::Serialize)]
struct PixelProof {
    width: u32,
    height: u32,
    exact: bool,
    changed_pixels: usize,
    maximum_channel_delta: u8,
    reference_sha256: String,
    candidate_sha256: String,
}

#[derive(serde::Deserialize)]
struct RasterRequest {
    context: ResourceRequestContext,
}

#[derive(serde::Deserialize)]
struct SessionCase {
    reference: PathBuf,
    project: PathBuf,
    rasters: Option<PathBuf>,
    output: Option<PathBuf>,
    samples: Vec<usize>,
    #[serde(default)]
    plugins: Vec<PathBuf>,
}

#[test]
#[ignore = "requires GPU, codec tools and independently captured plan references"]
fn native_project_session_matches_reference() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let cases: Vec<SessionCase> =
        if let Ok(path) = std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_BATCH") {
            serde_json::from_slice(&std::fs::read(path)?)?
        } else {
            vec![SessionCase {
                reference: PathBuf::from(std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_REFERENCE")?),
                project: PathBuf::from(std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_PROJECT")?),
                rasters: std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_RASTERS")
                    .ok()
                    .map(PathBuf::from),
                output: std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_OUTPUT")
                    .ok()
                    .map(PathBuf::from),
                samples: std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_SAMPLES")
                    .ok()
                    .map(|v| serde_json::from_str(&v))
                    .transpose()?
                    .unwrap_or_else(|| vec![0, 1, 5, 68]),
                plugins: std::env::var("ASTER_NATIVE_PROJECT_ASSEMBLY_PLUGINS")
                    .ok()
                    .map(|v| serde_json::from_str(&v))
                    .transpose()?
                    .unwrap_or_default(),
            }]
        };
    assert!(!cases.is_empty() && cases.len() <= 4096);
    let mut renderer = None;
    for case in cases {
        renderer = Some(case.run(&root, renderer)?);
    }
    Ok(())
}

impl SessionCase {
    fn run(
        self,
        root: &std::path::Path,
        renderer: Option<NativeRenderer>,
    ) -> Result<NativeRenderer, Box<dyn std::error::Error>> {
        let Self {
            reference: reference_directory,
            project,
            rasters: raster_directory,
            output: output_directory,
            samples,
            plugins,
        } = self;
        assert!(!samples.is_empty() && samples.len() <= 4096);
        if let Some(path) = &output_directory {
            std::fs::create_dir_all(path)?;
        }
        let options = Options::try_parse_from(["test"])?;
        let limits = DecodeLimits::default();
        let cancellation = CancellationToken::default();
        let mut requests = Vec::new();
        let mut reference_sources = BTreeSet::new();
        for sample in &samples {
            let directory = reference_directory.join(sample.to_string());
            let plan = FplnCodec::decode(std::fs::read(directory.join("replay.fpln"))?, &limits)?;
            let messages: Vec<aster_render_ir::ResourceMessage> =
                serde_json::from_slice(&std::fs::read(directory.join("resources.json"))?)?;
            for message in messages {
                if let aster_render_ir::ResourceMessage::PutResource(packet) = message
                    && let aster_render_ir::ResourceDescriptor::MediaSource(source) =
                        packet.descriptor
                    && source.media_kind != aster_render_ir::MediaKind::Raster
                    && let CompositionIdentity::Unicode(id) = source.source_id
                {
                    reference_sources.insert(id);
                }
            }
            let header = &plan.metadata.header;
            let CompositionIdentity::Unicode(id) = &header.composition_id else {
                return Err("composition identity absent".into());
            };
            requests.push(FramePlanRequest {
                snapshot_scope: header.snapshot_scope.clone(),
                project_revision: header.project_revision,
                composition_id: id.clone(),
                time: header.time.to_f64()?,
                target: header.target,
                render_target: header.render_target,
                anti_aliasing: header.aa,
                shadows_enabled: true,
            });
        }
        let mut settings = ProjectFrameSettings {
            resources: ResourceRequestContext {
                visualization: BufferVisualization::Beauty,
                locale: "en-US".into(),
                layouts: BTreeMap::new(),
                surface: SurfaceRequest {
                    revision: 1,
                    max_texture_dimension: 4096,
                    memory_budget_mb: Some(512.),
                    render_scale: f64::from(requests[0].render_target.width)
                        / f64::from(requests[0].target.width),
                },
                maximum_raster_dimension: 8192,
                maximum_raster_pixels: 67_108_864,
            },
            selected_layer_id: None,
            shadow_map_size: 1024,
        };
        if let Some(path) = &raster_directory {
            let request: RasterRequest = serde_json::from_slice(&std::fs::read(
                path.join(samples[0].to_string()).join("request.json"),
            )?)?;
            settings.resources = request.context;
        }
        let project_limits = options.project.clone();
        let mut reference_files = ReferenceResources::media_session(
            &project,
            &reference_sources,
            &requests[0].snapshot_scope,
            ProjectMediaTools {
                ffmpeg: root.join("build/ffmpeg/ffmpeg.exe"),
                ffprobe: root.join("build/ffmpeg/ffprobe.exe"),
            },
            (&project_limits, options.media.clone()),
            &cancellation,
        )?;
        let document = NativeProjectDocument::open(&project, options.project)?;
        let audio = NativeProjectAudio::new(
            &document,
            &requests[0].composition_id,
            ProjectMediaTools {
                ffmpeg: root.join("build/ffmpeg/ffmpeg.exe"),
                ffprobe: root.join("build/ffmpeg/ffprobe.exe"),
            },
            options.audio,
            &cancellation,
        )?;
        let files = NativeProjectFileMedia::new(
            document,
            &requests,
            &settings.resources,
            ProjectMediaTools {
                ffmpeg: root.join("build/ffmpeg/ffmpeg.exe"),
                ffprobe: root.join("build/ffmpeg/ffprobe.exe"),
            },
            options.media,
            &cancellation,
        )?;
        let mut reference_textures = NativeTextureSession::new(
            root.join("build/ffmpeg/ffmpeg.exe"),
            options.textures.clone(),
        )?;
        let materials = NativeProjectMaterials::new(
            root.join("build/ffmpeg/ffmpeg.exe"),
            options.textures,
            options.radiance,
        )?;
        let renderer = match renderer {
            Some(renderer) => renderer,
            None => NativeRenderer::new(NativeOptions {
                backend: if cfg!(target_os = "windows") {
                    aster_render::NativeBackend::Dx12
                } else if cfg!(target_os = "macos") {
                    aster_render::NativeBackend::Metal
                } else {
                    aster_render::NativeBackend::Vulkan
                },
                adapter_name: None,
                dxcompiler: cfg!(target_os = "windows")
                    .then(|| root.join("node_modules/electron/dist/dxcompiler.dll")),
                gpu_budget_bytes: 536870912,
                layer_cache_bytes: 0,
                effect_regions: true,
                effect_pipeline_entries: 0,
                gpu_timestamps: false,
                timeout: Duration::from_secs(30),
            })?,
        };
        let installed = NativeProjectGenerators::load_installed(
            &plugins,
            &settings.resources.locale,
            &Default::default(),
            &project_limits.bundle,
        )?;
        let catalog = NativeProjectGenerators::catalog(installed, project_limits.bundle.clone())?;
        let mut session = NativeProjectSession::new(
            files,
            materials,
            audio,
            NativeProjectGpu::new(renderer),
            catalog,
        )?;
        for (index, request) in requests.iter().enumerate() {
            let ReferenceResources {
                plan: reference,
                registry,
                decoded,
                images,
            } = ReferenceResources::load(
                &reference_directory,
                samples[index],
                &limits,
                &mut reference_textures,
                &mut reference_files,
                &cancellation,
            )?;
            let reference_plan = FplnCodec::decode(reference.reencode(&limits)?, &limits)?;
            let supplied =
                SuppliedFrame::with_textures(reference, &registry, &limits, &images, &decoded)?;
            let output = session.gpu.renderer.render(&supplied, &registry)?;
            let expected = session.gpu.renderer.read_rgba(&output)?;
            drop(output);
            let acquire = |requests: &aster_eval::ProjectResourceRequests| {
                if let Some(path) = &raster_directory {
                    ProjectRasterFrame::load(
                        &path.join(samples[index].to_string()).join("rasters.json"),
                        requests,
                        &project_limits,
                        &cancellation,
                    )
                } else {
                    Ok(ProjectRasterFrame::default())
                }
            };
            let stale = session.prepare(request, &settings, &cancellation, acquire)?;
            let prepared = session.prepare(request, &settings, &cancellation, acquire)?;
            assert!(session.render(&stale, &cancellation).is_err());
            let candidate = FplnCodec::decode(prepared.bundle.plan.encode(&limits)?, &limits)?;
            let comparison = PlanComparison::default().compare(
                &reference_plan,
                &registry,
                &candidate,
                &prepared.registry,
                &limits,
            )?;
            if let Some(path) = &output_directory {
                std::fs::write(
                    path.join(format!("plan-{index}.json")),
                    serde_json::to_vec_pretty(&comparison)?,
                )?;
            }
            assert!(
                comparison.equal,
                "{} time {}: {}",
                reference_directory.display(),
                request.time,
                serde_json::to_string(&comparison)?
            );
            let output = session.render(&prepared, &cancellation)?;
            let actual = session.gpu.renderer.read_rgba(&output)?;
            let pixels = PixelProof {
                width: request.target.width,
                height: request.target.height,
                exact: actual == expected,
                changed_pixels: actual
                    .chunks_exact(4)
                    .zip(expected.chunks_exact(4))
                    .filter(|(a, b)| a != b)
                    .count(),
                maximum_channel_delta: actual
                    .iter()
                    .zip(&expected)
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap_or(0),
                reference_sha256: format!("{:x}", Sha256::digest(&expected)),
                candidate_sha256: format!("{:x}", Sha256::digest(&actual)),
            };
            if let Some(path) = &output_directory {
                std::fs::write(
                    path.join(format!("pixels-{index}.json")),
                    serde_json::to_vec_pretty(&pixels)?,
                )?;
                if !pixels.exact {
                    std::fs::write(path.join(format!("reference-{index}.rgba")), &expected)?;
                    std::fs::write(path.join(format!("candidate-{index}.rgba")), &actual)?;
                }
            }
            assert!(
                pixels.exact,
                "native project pixels differ at {}",
                request.time
            );
            drop(output);
            assert!(session.render(&prepared, &cancellation).is_err());
        }
        cancellation.cancel();
        assert!(
            session
                .prepare(&requests[0], &settings, &cancellation, |_| Ok(
                    ProjectRasterFrame::default()
                ))
                .is_err()
        );
        assert!(
            session
                .prepare(
                    &requests[0],
                    &settings,
                    &CancellationToken::default(),
                    |_| Ok(ProjectRasterFrame::default())
                )
                .is_err()
        );
        Ok(session.gpu.renderer)
    }
}

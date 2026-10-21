use aster_eval::{BufferVisualization, FramePlanRequest, ResourceRequestContext, SurfaceRequest};
use aster_media_native::{ProjectMediaLimits, ProjectMediaTools, RadianceLimits, TextureLimits};
use aster_render_ir::{AntiAliasing, Extent2d};
use aster_render_project::{
    NativeProjectAudio, NativeProjectDocument, NativeProjectFileMedia, NativeProjectGenerators,
    NativeProjectGpu, NativeProjectMaterials, NativeProjectSession, ProjectAudioLimits,
    ProjectFrameSettings, ProjectRasterFrame, ProjectRenderLimits, ProjectTextRoute,
};
use aster_renderer::{NativeOptions, NativeRenderer};
use aster_video::CancellationToken;
use clap::Parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
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

#[derive(Deserialize)]
struct Case {
    project: PathBuf,
    project_sha256: String,
    composition: String,
    size: Extent2d,
    locale: String,
    samples: Vec<Sample>,
    output: PathBuf,
}

#[derive(Deserialize, Serialize)]
struct Sample {
    time: f64,
    scale: f64,
}

#[derive(Serialize)]
struct Receipt {
    sample: Sample,
    routes: Vec<ProjectTextRoute>,
    rgba_sha256: String,
    frame_rgba_sha256: String,
    retained_text_requests: usize,
    native_inputs: usize,
    source_sha256: String,
    stale_frame_rejected: bool,
}

#[test]
#[ignore = "requires GPU, codec tools and authenticated Canvas text observations"]
fn native_session_omits_ts_text_rasters() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    File::open(std::env::var("ASTER_TEXT_SESSION_INPUT")?)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    assert!(bytes.len() <= 16 * 1024 * 1024);
    let case: Case = serde_json::from_slice(&bytes)?;
    assert!(!case.samples.is_empty() && case.samples.len() <= 4096);
    assert!(case.samples.iter().all(|sample| sample.scale == 1.));
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let options = Options::try_parse_from(["text-session"])?;
    let cancellation = CancellationToken::default();
    let tools = || ProjectMediaTools {
        ffmpeg: root.join("build/ffmpeg/ffmpeg.exe"),
        ffprobe: root.join("build/ffmpeg/ffprobe.exe"),
    };
    let requests = case
        .samples
        .iter()
        .map(|sample| FramePlanRequest {
            snapshot_scope: format!("native-text:{}", case.project_sha256),
            project_revision: 1,
            composition_id: case.composition.clone(),
            time: sample.time,
            target: case.size,
            render_target: case.size,
            anti_aliasing: AntiAliasing::Off,
            shadows_enabled: true,
        })
        .collect::<Vec<_>>();
    let mut settings = ProjectFrameSettings {
        resources: ResourceRequestContext {
            visualization: BufferVisualization::Beauty,
            locale: case.locale,
            layouts: BTreeMap::new(),
            surface: SurfaceRequest {
                revision: 1,
                max_texture_dimension: 4096,
                memory_budget_mb: Some(512.),
                render_scale: 1.,
            },
            maximum_raster_dimension: 4096,
            maximum_raster_pixels: 67_108_864,
        },
        selected_layer_id: None,
        shadow_map_size: 1024,
    };
    let document = NativeProjectDocument::open(&case.project, options.project.clone())?;
    assert_eq!(document.authored_sha256, case.project_sha256);
    let audio = NativeProjectAudio::new(
        &document,
        &case.composition,
        tools(),
        options.audio,
        &cancellation,
    )?;
    let files = NativeProjectFileMedia::new(
        document,
        &requests,
        &settings.resources,
        tools(),
        options.media,
        &cancellation,
    )?;
    let materials = NativeProjectMaterials::new(
        root.join("build/ffmpeg/ffmpeg.exe"),
        options.textures,
        options.radiance,
    )?;
    let renderer = NativeRenderer::new(NativeOptions {
        backend: aster_render::NativeBackend::Dx12,
        adapter_name: None,
        dxcompiler: Some(root.join("node_modules/electron/dist/dxcompiler.dll")),
        gpu_budget_bytes: 536870912,
        layer_cache_bytes: 0,
        effect_regions: true,
        effect_pipeline_entries: 0,
        gpu_timestamps: false,
        timeout: Duration::from_secs(30),
    })?;
    let catalog = NativeProjectGenerators::catalog(Vec::new(), options.project.bundle)?;
    let mut session = NativeProjectSession::new(
        files,
        materials,
        audio,
        NativeProjectGpu::new(renderer),
        catalog,
    )?;
    fs::create_dir_all(&case.output)?;
    let mut receipts = Vec::new();
    for (index, (request, sample)) in requests.iter().zip(case.samples).enumerate() {
        settings.resources.surface.render_scale = sample.scale;
        let acquire = |requests: &aster_eval::ProjectResourceRequests| {
            assert!(!requests.operations.iter().any(|o| matches!(o,
                aster_eval::ResourcePreparationOperation::Raster { request } if matches!(request.raster, aster_eval::RetainedRasterKind::Text { .. }))));
            Ok(ProjectRasterFrame::default())
        };
        let stale = session.prepare(request, &settings, &cancellation, acquire)?;
        let prepared = session.prepare(request, &settings, &cancellation, acquire)?;
        assert!(session.render(&stale, &cancellation).is_err());
        assert_eq!(prepared.native_text.len(), 1);
        assert_eq!(prepared.text_routes.len(), 1);
        assert!(prepared.text_routes[0].frame.is_some());
        let output = session.render(&prepared, &cancellation)?;
        let rgba = session
            .gpu
            .renderer
            .read_native_glyph_rgba(&prepared.native_text[0])?;
        let frame_rgba = session.gpu.renderer.read_rgba(&output)?;
        drop(output);
        let mut file = File::options()
            .create_new(true)
            .write(true)
            .open(case.output.join(format!("{index}.rgba")))?;
        file.write_all(&rgba)?;
        file.sync_all()?;
        let mut frame_file = File::options()
            .create_new(true)
            .write(true)
            .open(case.output.join(format!("{index}.frame.rgba")))?;
        frame_file.write_all(&frame_rgba)?;
        frame_file.sync_all()?;
        receipts.push(Receipt {
            sample,
            routes: prepared.text_routes,
            rgba_sha256: format!("{:x}", Sha256::digest(&rgba)),
            frame_rgba_sha256: format!("{:x}", Sha256::digest(&frame_rgba)),
            retained_text_requests: 0,
            native_inputs: 1,
            source_sha256: case.project_sha256.clone(),
            stale_frame_rejected: true,
        });
    }
    let mut file = File::options()
        .create_new(true)
        .write(true)
        .open(case.output.join("receipts.json"))?;
    file.write_all(&serde_json::to_vec(&receipts)?)?;
    file.sync_all()?;
    Ok(())
}

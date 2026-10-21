use aster_render_ir::{
    DecodeLimits, FplnCodec, MediaSample, PlanSlice, RasterOrigin, ResourceDescriptor,
    ResourceKind, ResourceMessage, ResourceRegistry,
};
use aster_render_project::{
    NativeProjectAudio, NativeProjectDocument, NativeProjectFileMedia, NativeProjectGenerators,
    NativeProjectGpu, NativeProjectMaterials, NativeProjectSession, NativeProjectText,
    ProjectAudioLimits, ProjectFrameSettings, ProjectRasterFrame, ProjectRenderLimits,
    ProjectTextOutcome, ProjectTextRequest,
};
use aster_renderer::{NativeOptions, NativeRenderer, SuppliedFrame};
use aster_text::{FontCatalogConfig, FontDiscoveryConfig};
use clap::Parser;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    time::Duration,
};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    limits: ProjectRenderLimits,
    #[command(flatten)]
    media: aster_media_native::ProjectMediaLimits,
    #[command(flatten)]
    audio: ProjectAudioLimits,
    #[command(flatten)]
    textures: aster_media_native::TextureLimits,
    #[command(flatten)]
    radiance: aster_media_native::RadianceLimits,
}
#[derive(Deserialize)]
struct PixelCase {
    project: PathBuf,
    project_sha256: String,
    request: ProjectTextRequest,
    plan: PathBuf,
    plan_sha256: String,
    resources: PathBuf,
    output: PathBuf,
}
#[derive(Serialize)]
struct PixelReceipt {
    project_sha256: String,
    request: ProjectTextRequest,
    layer_rgba_sha256: String,
    original_plan_sha256: String,
    native_plan_sha256: String,
    reference_rgba_sha256: String,
    native_rgba_sha256: String,
    width: u32,
    height: u32,
    removed_cpu_rasters: usize,
    glyph_draws: usize,
    atlas_bytes: usize,
    retained_session_exact: bool,
    retained_reason: String,
}

#[test]
#[ignore = "requires GPU, authenticated TS plans and installed project fonts"]
fn authored_text_pixels_from_native_recipes() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    File::open(std::env::var("ASTER_PROJECT_TEXT_PIXEL_INPUT")?)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    assert!(bytes.len() <= 16 * 1024 * 1024);
    let cases: Vec<PixelCase> = serde_json::from_slice(&bytes)?;
    assert!(!cases.is_empty() && cases.len() <= 256);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: if cfg!(windows) {
            aster_render::NativeBackend::Dx12
        } else if cfg!(target_os = "macos") {
            aster_render::NativeBackend::Metal
        } else {
            aster_render::NativeBackend::Vulkan
        },
        adapter_name: None,
        dxcompiler: cfg!(windows).then(|| root.join("node_modules/electron/dist/dxcompiler.dll")),
        gpu_budget_bytes: 256 * 1024 * 1024,
        layer_cache_bytes: 16 * 1024 * 1024,
        effect_regions: true,
        effect_pipeline_entries: 32,
        gpu_timestamps: false,
        timeout: Duration::from_secs(30),
    })?;
    let mut receipts = Vec::new();
    for case in cases {
        let document = NativeProjectDocument::open(
            &case.project,
            Options::try_parse_from(["pixel-test"])?.limits,
        )?;
        assert_eq!(document.authored_sha256, case.project_sha256);
        let fonts = NativeProjectText::discover_platform(
            &document,
            &FontDiscoveryConfig::default(),
            FontCatalogConfig::default(),
        )?;
        let mut text = NativeProjectText::new(&document, fonts)?;
        let ProjectTextOutcome::Native(prepared) = text.prepare(&document, case.request.clone())?
        else {
            return Err("requested text is not natively prepared".into());
        };
        let glyph_draws = prepared.plan.draws.len();
        let atlas_bytes = prepared.atlas.bytes;
        let original = fs::read(&case.plan)?;
        assert_eq!(format!("{:x}", Sha256::digest(&original)), case.plan_sha256);
        let limits = DecodeLimits::default();
        let mut plan = FplnCodec::decode(original.clone(), &limits)?;
        let size = plan.metadata.header.target;
        let messages: Vec<ResourceMessage> =
            serde_json::from_slice(&fs::read(case.plan.with_file_name("resources.json"))?)?;
        let mut requests = Vec::new();
        let mut hashes = BTreeSet::new();
        for message in messages {
            let ResourceMessage::PutResource(request) = message else {
                return Err("unexpected resource eviction".into());
            };
            assert!(hashes.insert(request.hash.clone()));
            requests.push(request);
        }
        assert!(plan.metadata.resources.iter().eq(hashes.iter()));
        requests.sort_by_key(|r| match r.kind {
            ResourceKind::MediaSource => 0,
            ResourceKind::MediaFrame => 1,
            ResourceKind::RasterPixels => 2,
            _ => 3,
        });
        let mut registry = ResourceRegistry::new(Default::default())?;
        for request in requests {
            let bytes = fs::read(case.resources.join(format!("{}.bin", request.hash.0)))?;
            registry.put(request, bytes)?;
        }
        let reference = SuppliedFrame::new(
            FplnCodec::decode(original, &limits)?,
            &registry,
            &limits,
            &[],
        )?;
        let reference_frame = renderer.render(&reference, &registry)?;
        let reference_rgba = renderer.read_rgba(&reference_frame)?;
        drop(reference_frame);
        drop(reference);
        let header = plan.metadata.header.clone();
        let Some(PlanSlice::FrameBundle(bundle)) = plan.metadata.slices.first_mut() else {
            return Err("complete frame required".into());
        };
        // Supplied root-frame evidence must contain exactly one ordinary text raster.
        assert!(bundle.temporal.is_empty() && bundle.precompositions.is_none());
        let selected=bundle.media_pixels.iter().filter_map(|record|match registry.descriptor(&record.frame) {
            Ok(ResourceDescriptor::MediaFrame(frame)) if matches!(&frame.sample,MediaSample::Raster(sample)if sample.origin==RasterOrigin::Text)=>Some(record.clone()),_=>None
        }).collect::<Vec<_>>();
        assert_eq!(selected.len(), 1);
        let record = &selected[0];
        let ResourceDescriptor::MediaFrame(descriptor) = registry.descriptor(&record.frame)? else {
            return Err("text descriptor absent".into());
        };
        assert_eq!(
            (descriptor.width, descriptor.height),
            (prepared.plan.size.width, prepared.plan.size.height)
        );
        let MediaSample::Raster(sample) = &descriptor.sample else {
            return Err("raster sample absent".into());
        };
        assert_eq!(sample.bounds()?, prepared.bounds);
        let ResourceDescriptor::MediaSource(source) = registry.descriptor(&descriptor.source)?
        else {
            return Err("text source absent".into());
        };
        assert_eq!(
            serde_json::to_value(&source.source_id)?,
            serde_json::to_value(&case.request.layer)?
        );
        let layer_rgba_sha256 = format!("{:x}", Sha256::digest(registry.resolve(&record.pixels)?));

        let (next_renderer, retained_reason) =
            case.retained_session(renderer, &header, &registry, record, &reference_rgba)?;
        renderer = next_renderer;

        let input = prepared.into_input(record.frame.clone(), 256 * 1024 * 1024)?;
        bundle.media_pixels.retain(|p| p.frame != record.frame);
        assert!(
            bundle
                .media_pixels
                .iter()
                .all(|p| p.pixels != record.pixels)
        );
        plan.metadata
            .resources
            .retain(|hash| hash != &record.pixels);
        registry.evict(&record.pixels)?;
        let counts = [
            bundle.shadow_map_size,
            bundle.effects.len() as u32,
            bundle.generators.len() as u32,
            u32::from(bundle.precompositions.is_some()),
            bundle.media_pixels.len() as u32,
            bundle.temporal.len() as u32,
        ];
        let blob = counts
            .into_iter()
            .flat_map(u32::to_le_bytes)
            .collect::<Vec<_>>();
        let encoded = FplnCodec::encode(plan.metadata, &[&blob], &limits)?;
        let native_plan_sha256 = format!("{:x}", Sha256::digest(&encoded));
        assert!(
            SuppliedFrame::new(
                FplnCodec::decode(encoded.clone(), &limits)?,
                &registry,
                &limits,
                &[]
            )
            .is_err()
        );
        let native = SuppliedFrame::with_native_glyphs(
            FplnCodec::decode(encoded, &limits)?,
            &registry,
            &limits,
            &[],
            &[],
            vec![input],
        )?;
        let output = renderer.render(&native, &registry)?;
        let native_rgba = renderer.read_rgba(&output)?;
        if let Some(parent) = case.output.parent() {
            fs::create_dir_all(parent)?;
        }
        PixelReceipt::publish(case.output.clone(), &native_rgba)?;
        PixelReceipt::publish(
            case.output.with_extension("reference.rgba"),
            &reference_rgba,
        )?;
        receipts.push(PixelReceipt {
            project_sha256: document.authored_sha256,
            request: case.request,
            layer_rgba_sha256,
            original_plan_sha256: case.plan_sha256,
            native_plan_sha256,
            reference_rgba_sha256: format!("{:x}", Sha256::digest(&reference_rgba)),
            native_rgba_sha256: format!("{:x}", Sha256::digest(&native_rgba)),
            width: size.width,
            height: size.height,
            removed_cpu_rasters: 1,
            glyph_draws,
            atlas_bytes,
            retained_session_exact: true,
            retained_reason,
        });
    }
    PixelReceipt::publish(
        PathBuf::from(std::env::var("ASTER_PROJECT_TEXT_PIXEL_OUTPUT")?),
        &serde_json::to_vec(&receipts)?,
    )?;
    Ok(())
}

impl PixelCase {
    fn retained_session(
        &self,
        renderer: NativeRenderer,
        header: &aster_render_ir::FrameHeaderSlice,
        registry: &ResourceRegistry,
        record: &aster_render_ir::PrecompositionMediaPixels,
        expected: &[u8],
    ) -> Result<(NativeRenderer, String), Box<dyn std::error::Error>> {
        use aster_eval::{
            BufferVisualization, FramePlanRequest, ResourceRequestContext, SurfaceRequest,
        };
        use aster_render_ir::{CompositionIdentity, VerifiedResource};
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .canonicalize()?;
        let options = Options::try_parse_from(["retained-text"])?;
        let cancellation = aster_video::CancellationToken::default();
        let tools = || aster_media_native::ProjectMediaTools {
            ffmpeg: root.join("build/ffmpeg/ffmpeg.exe"),
            ffprobe: root.join("build/ffmpeg/ffprobe.exe"),
        };
        let CompositionIdentity::Unicode(composition) = &header.composition_id else {
            return Err("composition identity absent".into());
        };
        let request = FramePlanRequest {
            snapshot_scope: header.snapshot_scope.clone(),
            project_revision: header.project_revision,
            composition_id: composition.clone(),
            time: header.time.to_f64()?,
            target: header.target,
            render_target: header.render_target,
            anti_aliasing: header.aa,
            shadows_enabled: true,
        };
        let settings = ProjectFrameSettings {
            resources: ResourceRequestContext {
                visualization: BufferVisualization::Beauty,
                locale: self.request.locale.clone(),
                layouts: Default::default(),
                surface: SurfaceRequest {
                    revision: 1,
                    max_texture_dimension: 4096,
                    memory_budget_mb: Some(256.),
                    render_scale: 1.,
                },
                maximum_raster_dimension: 4096,
                maximum_raster_pixels: 67_108_864,
            },
            selected_layer_id: None,
            shadow_map_size: 1024,
        };
        let document = NativeProjectDocument::open(&self.project, options.limits.clone())?;
        let audio = NativeProjectAudio::new(
            &document,
            composition,
            tools(),
            options.audio,
            &cancellation,
        )?;
        let files = NativeProjectFileMedia::new(
            document,
            std::slice::from_ref(&request),
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
        let catalog = NativeProjectGenerators::catalog(Vec::new(), options.limits.bundle)?;
        let mut session = NativeProjectSession::new(
            files,
            materials,
            audio,
            NativeProjectGpu::new(renderer),
            catalog,
        )?;
        let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(&record.frame)? else {
            return Err("frame absent".into());
        };
        let MediaSample::Raster(sample) = &frame.sample else {
            return Err("sample absent".into());
        };
        let [x, y, width, height] = sample.bounds()?;
        let prepared = session.prepare(&request, &settings, &cancellation, |requests| {
            let text = requests
                .operations
                .iter()
                .filter_map(|operation| match operation {
                    aster_eval::ResourcePreparationOperation::Raster { request } => Some(request),
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(text.len(), 1);
            assert_eq!(text[0].layer_id, self.request.layer);
            let pixels = VerifiedResource::new(
                ResourceKind::Buffer,
                registry.descriptor(&record.pixels)?.clone(),
                registry.resolve(&record.pixels)?.to_vec(),
            )?;
            Ok(ProjectRasterFrame {
                request_sha256: Some(format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(requests)?)
                )),
                bindings: [(text[0].instance_id.clone(), Some(record.frame.clone()))].into(),
                resources: vec![
                    VerifiedResource::new(
                        ResourceKind::MediaSource,
                        registry.descriptor(&frame.source)?.clone(),
                        Vec::new(),
                    )?,
                    VerifiedResource::new(
                        ResourceKind::MediaFrame,
                        ResourceDescriptor::MediaFrame(frame.clone()),
                        Vec::new(),
                    )?,
                ],
                pixels: vec![aster_eval::BundleMediaPixels {
                    frame: record.frame.clone(),
                    pixels,
                }],
                text_bounds: [(
                    text[0].instance_id.clone(),
                    aster_eval::TextGeometryBounds {
                        x,
                        y,
                        width,
                        height,
                    },
                )]
                .into(),
                ..Default::default()
            })
        })?;
        assert!(prepared.native_text.is_empty());
        assert_eq!(prepared.text_routes.len(), 1);
        assert!(prepared.text_routes[0].frame.is_none());
        let reason = prepared.text_routes[0].capability.reason.clone();
        assert_eq!(
            reason,
            "stroke coverage exceeds the isolated raster alpha limit"
        );
        let rendered = session.render(&prepared, &cancellation)?;
        assert_eq!(session.gpu.renderer.read_rgba(&rendered)?, expected);
        drop(rendered);
        Ok((session.gpu.renderer, reason))
    }
}

impl PixelReceipt {
    fn publish(path: PathBuf, bytes: &[u8]) -> Result<(), Box<dyn std::error::Error>> {
        if path.exists() {
            return Err("pixel evidence already exists".into());
        }
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let mut file = File::options()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::rename(&temporary, path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

use aster_media_native::{
    NativeProjectMediaSession, NativeTextureSession, ProjectMediaLimits, ProjectMediaTools,
};
use aster_project::{MediaSourceReader, ProjectMediaCatalog, RuntimeProjectDocument};
use aster_render_ir::{
    DecodeLimits, FplnCodec, MediaSample, OwnedFpln, PrecompositionMediaPixels, ResourceDescriptor,
    ResourceKind, ResourceMessage, ResourceRegistry, TextureDimension, TexturePixelFormat,
    TexturePixelsDescriptor, VerifiedResource,
};
use aster_render_project::ProjectRenderLimits;
use aster_renderer::DecodedTexturePixels;
use aster_video::CancellationToken;
use std::{collections::BTreeSet, path::Path};

pub struct ReferenceResources {
    pub plan: OwnedFpln,
    pub registry: ResourceRegistry,
    pub decoded: Vec<DecodedTexturePixels>,
    pub images: Vec<PrecompositionMediaPixels>,
}

impl ReferenceResources {
    pub fn media_session(
        project: &Path,
        sources: &BTreeSet<String>,
        scope: &str,
        tools: ProjectMediaTools,
        limits: (&ProjectRenderLimits, ProjectMediaLimits),
        cancellation: &CancellationToken,
    ) -> Result<NativeProjectMediaSession, Box<dyn std::error::Error>> {
        let path = if project.is_dir() {
            project.join("project.json")
        } else {
            project.to_owned()
        }
        .canonicalize()?;
        let raw = std::fs::read(&path)?;
        let runtime = RuntimeProjectDocument::from_slice(&raw, &Default::default())?.encode()?;
        let catalog = ProjectMediaCatalog::from_slice(&runtime, &limits.0.catalog)?;
        let bindings = sources
            .iter()
            .map(|id| catalog.bind(id))
            .collect::<Result<Vec<_>, _>>()?;
        let mut reader = MediaSourceReader::new(
            path.parent().ok_or("reference project parent absent")?,
            limits.0.sources.clone(),
        )?;
        Ok(NativeProjectMediaSession::new(
            bindings,
            &mut reader,
            scope,
            tools,
            limits.1,
            cancellation,
        )?)
    }

    pub fn load(
        directory: &Path,
        sample: usize,
        limits: &DecodeLimits,
        textures: &mut NativeTextureSession,
        files: &mut NativeProjectMediaSession,
        cancellation: &CancellationToken,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let sample = directory.join(sample.to_string());
        let plan = FplnCodec::decode(std::fs::read(sample.join("replay.fpln"))?, limits)?;
        let mut messages: Vec<ResourceMessage> =
            serde_json::from_slice(&std::fs::read(sample.join("resources.json"))?)?;
        messages.sort_by_key(|message| match message {
            ResourceMessage::PutResource(packet) => match packet.kind {
                ResourceKind::MediaSource => 0,
                ResourceKind::MediaFrame => 2,
                ResourceKind::RasterPixels => 3,
                _ => 1,
            },
            _ => 4,
        });
        let mut registry = ResourceRegistry::new(Default::default())?;
        for message in messages {
            let ResourceMessage::PutResource(packet) = message else {
                return Err("reference contains unexpected eviction".into());
            };
            let bytes =
                std::fs::read(directory.join(format!("frame-resources/{}.bin", packet.hash.0)))?;
            registry.put(packet, bytes)?;
        }
        let mut decoded = Vec::new();
        let mut frames = Vec::new();
        let mut requested = 0_u64;
        for hash in &plan.metadata.resources {
            if let ResourceDescriptor::MediaFrame(frame) = registry.descriptor(hash)?
                && !matches!(frame.sample, MediaSample::Raster(_))
            {
                frames.push(hash.clone());
                requested = requested
                    .checked_add(
                        u64::from(frame.width)
                            * u64::from(frame.height)
                            * u64::from(frame.format.bytes_per_pixel()),
                    )
                    .ok_or("reference pixel byte overflow")?;
            }
        }
        let stats = registry.statistics();
        if requested > stats.budget_bytes.saturating_sub(stats.used_bytes) {
            return Err("decoded reference images exceed budget".into());
        }
        let mut images = Vec::new();
        for (frame, decoded) in
            frames
                .iter()
                .zip(files.decode_frames(&frames, &registry, cancellation)?)
        {
            images.push(PrecompositionMediaPixels {
                frame: frame.clone(),
                pixels: decoded.pixels.request().hash.clone(),
            });
            registry.put_verified(decoded.pixels)?;
        }
        for hash in &plan.metadata.resources {
            if !matches!(
                registry.descriptor(hash)?,
                ResourceDescriptor::EncodedTexture(_)
            ) {
                continue;
            }
            let (width, height) = textures.extent(hash, &registry)?;
            let stats = registry.statistics();
            if u64::from(width) * u64::from(height) * 4
                > stats.budget_bytes.saturating_sub(stats.used_bytes)
            {
                return Err("decoded reference texture exceeds budget".into());
            }
            let pixels = textures.decode(hash, &registry, cancellation)?;
            let resource = VerifiedResource::new(
                ResourceKind::TexturePixels,
                ResourceDescriptor::TexturePixels(TexturePixelsDescriptor {
                    dimension: TextureDimension::D2,
                    width,
                    height,
                    depth: 1,
                    format: TexturePixelFormat::Rgba8Unorm,
                }),
                pixels.bytes.to_vec(),
            )?;
            decoded.push(DecodedTexturePixels {
                encoded: hash.clone(),
                pixels: resource.request().hash.clone(),
            });
            registry.put_verified(resource)?;
        }
        Ok(Self {
            plan,
            registry,
            decoded,
            images,
        })
    }
}

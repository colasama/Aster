use std::path::PathBuf;

use aster_media_native::{
    MediaCacheStatistics, NativeTextureReceipt, NativeTextureSession, TextureLimits,
};
use aster_render_ir::{
    OwnedFpln, PutResource, ResourceDescriptor, ResourceHash, ResourceKind, ResourceRegistry,
    TextureDimension, TexturePixelFormat, TexturePixelsDescriptor,
};
use aster_renderer::DecodedTexturePixels;
use clap::Args;

#[derive(Debug, Args)]
pub struct NativeTextureArgs {
    /// Existing packaged codec for inline normal maps; this grants no media file access.
    #[arg(long)]
    texture_ffmpeg: Option<PathBuf>,
    #[command(flatten)]
    limits: TextureLimits,
}

#[derive(Default)]
pub struct NativeTextureResources {
    pub pixels: Vec<DecodedTexturePixels>,
    pub receipts: Vec<NativeTextureReceipt>,
    pub cache: MediaCacheStatistics,
}

impl NativeTextureArgs {
    pub fn session(&self) -> Result<Option<NativeTextureSession>, aster_media_native::MediaError> {
        self.texture_ffmpeg
            .as_ref()
            .map(|path| NativeTextureSession::new(path.clone(), self.limits.clone()))
            .transpose()
    }
}

impl NativeTextureResources {
    pub fn install(
        session: Option<&mut NativeTextureSession>,
        plan: &OwnedFpln,
        registry: &mut ResourceRegistry,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let mut result = Self::default();
        let mut hashes = Vec::new();
        for hash in &plan.metadata.resources {
            if matches!(
                registry.descriptor(hash)?,
                ResourceDescriptor::EncodedTexture(_)
            ) {
                hashes.push(hash.clone());
            }
        }
        let Some(session) = session else {
            if !hashes.is_empty() {
                return Err("--texture-ffmpeg is required for native normal textures".into());
            }
            return Ok(result);
        };
        let mut requested = 0_u64;
        for hash in &hashes {
            let (width, height) = session.extent(hash, registry)?;
            requested = requested
                .checked_add(u64::from(width) * u64::from(height) * 4)
                .ok_or("decoded texture allocation overflow")?;
        }
        let stats = registry.statistics();
        if requested > stats.budget_bytes.saturating_sub(stats.used_bytes) {
            return Err("native decoded textures exceed resource byte budget".into());
        }
        let mut staged = Vec::new();
        for hash in hashes {
            let decoded =
                session.decode(&hash, registry, &aster_video::CancellationToken::default())?;
            let descriptor = TexturePixelsDescriptor {
                dimension: TextureDimension::D2,
                width: decoded.receipt.width,
                height: decoded.receipt.height,
                depth: 1,
                format: TexturePixelFormat::Rgba8Unorm,
            };
            let pixels = ResourceHash::for_resource(
                ResourceKind::TexturePixels,
                &ResourceDescriptor::TexturePixels(descriptor.clone()),
                &decoded.bytes,
            )?;
            staged.push((
                PutResource {
                    hash: pixels.clone(),
                    kind: ResourceKind::TexturePixels,
                    descriptor: ResourceDescriptor::TexturePixels(descriptor),
                },
                decoded.bytes.to_vec(),
            ));
            result.pixels.push(DecodedTexturePixels {
                encoded: hash,
                pixels,
            });
            result.receipts.push(decoded.receipt);
        }
        for (request, bytes) in staged {
            registry.put(request, bytes)?;
        }
        result.cache = session.statistics();
        Ok(result)
    }
}

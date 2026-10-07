use aster_render_ir::{
    PutResource, ResourceDescriptor, ResourceLimits, ResourceRegistry, TextureEncoding,
};
use aster_video::CancellationToken;
use base64::Engine;
use serde::Deserialize;

use crate::{MediaError, NativeTextureSession, TextureLimits};

#[derive(Deserialize)]
struct TextureFixtures {
    fixtures: Vec<TextureFixture>,
}

#[derive(Deserialize)]
struct TextureFixture {
    message: PutResource,
    encoded: String,
    rgba: Vec<u8>,
}

impl TextureFixtures {
    fn load() -> Result<Self, Box<dyn std::error::Error>> {
        Ok(serde_json::from_str(include_str!(
            "../../../tests/parity/assets/normal-textures.json"
        ))?)
    }

    fn session(budget: u64) -> Result<NativeTextureSession, MediaError> {
        NativeTextureSession::new(
            "nonexistent-ffmpeg".into(),
            TextureLimits {
                texture_max_source_bytes: 4096,
                texture_max_pixel_bytes: 128,
                texture_max_dimension: 8,
                texture_timeout_ms: 1000,
                texture_cache_bytes: budget,
                texture_cache_entries: 1,
            },
        )
    }
}

#[test]
fn native_lossy_normals_match_browser_and_reuse_authenticated_generations()
-> Result<(), Box<dyn std::error::Error>> {
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    let mut session = TextureFixtures::session(24)?;
    let mut count = 0;
    let mut fixtures = TextureFixtures::load()?.fixtures;
    let source = fixtures.iter().find(|f| matches!(&f.message.descriptor, ResourceDescriptor::EncodedTexture(d) if d.encoding == TextureEncoding::Webp)).ok_or("WebP fixture missing")?;
    let mut encoded = base64::prelude::BASE64_STANDARD.decode(&source.encoded)?;
    encoded.extend_from_slice(b"TEST\x04\0\0\0test");
    let length = encoded.len() as u32 - 8;
    encoded[4..8].copy_from_slice(&length.to_le_bytes());
    let mut message = source.message.clone();
    message.hash =
        aster_render_ir::ResourceHash::for_resource(message.kind, &message.descriptor, &encoded)?;
    fixtures.push(TextureFixture {
        message,
        encoded: base64::prelude::BASE64_STANDARD.encode(encoded),
        rgba: source.rgba.clone(),
    });
    for fixture in fixtures {
        let ResourceDescriptor::EncodedTexture(descriptor) = &fixture.message.descriptor else {
            return Err("fixture is not encoded texture".into());
        };
        if descriptor.encoding == TextureEncoding::Png
            || (descriptor.encoding == TextureEncoding::Jpeg && !cfg!(windows))
        {
            continue;
        }
        let hash = fixture.message.hash.clone();
        registry.put(
            fixture.message,
            base64::prelude::BASE64_STANDARD.decode(fixture.encoded)?,
        )?;
        let decoded = session.decode(&hash, &registry, &CancellationToken::default())?;
        assert_eq!(
            decoded.bytes.as_ref(),
            fixture.rgba,
            "{:?}",
            decoded.receipt.encoding
        );
        let reused = session.decode(&hash, &registry, &CancellationToken::default())?;
        assert!(std::sync::Arc::ptr_eq(&decoded.bytes, &reused.bytes));
        count += 1;
        assert_eq!(session.statistics().decodes, count);
        assert_eq!(session.statistics().hits, count);
        assert_eq!(session.statistics().resident_bytes, 24);
        assert_eq!(session.statistics().entries, 1);
        assert_eq!(session.statistics().evictions, count - 1);
        let mut uncached = TextureFixtures::session(0)?;
        for _ in 0..2 {
            assert_eq!(
                uncached
                    .decode(&hash, &registry, &CancellationToken::default())?
                    .bytes
                    .as_ref(),
                fixture.rgba
            );
        }
        assert_eq!(uncached.statistics().decodes, 2);
        assert_eq!(uncached.statistics().resident_bytes, 0);
        assert_eq!(uncached.statistics().entries, 0);
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        assert!(matches!(
            session.decode(&hash, &registry, &cancelled),
            Err(MediaError::Decode(aster_video::FfmpegError::Cancelled))
        ));
    }
    assert_eq!(count, if cfg!(windows) { 3 } else { 2 });
    Ok(())
}

#[test]
fn texture_extent_limits_precede_decode_or_retention() -> Result<(), Box<dyn std::error::Error>> {
    let mut fixture = TextureFixtures::load()?.fixtures.remove(0);
    let mut bytes = base64::prelude::BASE64_STANDARD.decode(fixture.encoded)?;
    bytes[16..20].copy_from_slice(&4097_u32.to_be_bytes());
    fixture.message.hash = aster_render_ir::ResourceHash::for_resource(
        fixture.message.kind,
        &fixture.message.descriptor,
        &bytes,
    )?;
    let hash = fixture.message.hash.clone();
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    registry.put(fixture.message, bytes)?;
    let mut session = TextureFixtures::session(24)?;
    assert!(matches!(
        session.decode(&hash, &registry, &CancellationToken::default()),
        Err(MediaError::Limit(_))
    ));
    assert_eq!(session.statistics().decodes, 0);
    assert_eq!(session.statistics().resident_bytes, 0);
    Ok(())
}

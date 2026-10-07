use std::{io::Cursor, path::PathBuf};

use aster_render_ir::{
    CompositionIdentity, MediaFrameDescriptor, MediaKind, MediaSample, MediaSourceDescriptor,
    MediaTextureFormat, PutResource, ResourceDescriptor, ResourceHash, ResourceKind,
    ResourceLimits, ResourceRegistry,
};
use aster_video::{CancellationToken, FfmpegError};
use exr::prelude::{Image, SpecificChannels, WritableImage};
use sha2::{Digest, Sha256};

use crate::{
    MediaCacheLimits, MediaError, NativeMediaSession, NativeStillDecoder, StillAuthorization,
    StillLimits,
};

struct Fixture {
    registry: ResourceRegistry,
    frame: ResourceHash,
    grant: StillAuthorization,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.grant.path);
    }
}

impl Fixture {
    fn new(value: f32, sha_identity: bool) -> Result<Self, Box<dyn std::error::Error>> {
        let mut encoded = Cursor::new(Vec::new());
        Image::from_channels(
            (2, 1),
            SpecificChannels::rgba(move |_| (value, 0.0_f32, 0.0_f32, 1.0_f32)),
        )
        .write()
        .non_parallel()
        .to_buffered(&mut encoded)?;
        let encoded = encoded.into_inner();
        let (mut left, mut right) = (0x811c9dc5_u32, 0x9e3779b9_u32);
        for byte in &encoded {
            left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        let descriptor = ResourceDescriptor::MediaSource(MediaSourceDescriptor {
            source_id: CompositionIdentity::Unicode(format!("cache-{value}")),
            content_identity: if sha_identity {
                format!("sha256:{:x}", Sha256::digest(&encoded))
            } else {
                format!("fnv64:{left:08x}{right:08x}:{}", encoded.len())
            },
            authorization_scope: "cache-job".into(),
            media_kind: MediaKind::Image,
        });
        let source = ResourceHash::for_resource(ResourceKind::MediaSource, &descriptor, &[])?;
        let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
        registry.put(
            PutResource {
                hash: source.clone(),
                kind: ResourceKind::MediaSource,
                descriptor,
            },
            vec![],
        )?;
        let descriptor = ResourceDescriptor::MediaFrame(MediaFrameDescriptor {
            source: source.clone(),
            sample: MediaSample::Image,
            width: 2,
            height: 1,
            format: MediaTextureFormat::Rgba16Float,
        });
        let frame = ResourceHash::for_resource(ResourceKind::MediaFrame, &descriptor, &[])?;
        registry.put(
            PutResource {
                hash: frame.clone(),
                kind: ResourceKind::MediaFrame,
                descriptor,
            },
            vec![],
        )?;
        let result = Self {
            registry,
            frame,
            grant: StillAuthorization {
                source,
                sequence_frame: None,
                scope: "cache-job".into(),
                path: std::env::temp_dir()
                    .join(format!("aster-decode-cache-{}.exr", uuid::Uuid::new_v4())),
                sha256: format!("{:x}", Sha256::digest(&encoded)),
            },
        };
        std::fs::write(&result.grant.path, encoded)?;
        Ok(result)
    }

    fn session(
        grants: Vec<StillAuthorization>,
        bytes: u64,
        entries: usize,
    ) -> Result<NativeMediaSession, MediaError> {
        let still = NativeStillDecoder::new(
            PathBuf::from("unused-for-exr"),
            grants,
            StillLimits {
                still_max_source_bytes: 1_048_576,
                still_max_pixel_bytes: 1024,
                still_max_dimension: 32,
                still_timeout_ms: 1000,
                still_max_header_bytes: 65536,
            },
        )?;
        Ok(NativeMediaSession::new(
            still,
            None,
            MediaCacheLimits {
                media_cache_bytes: bytes,
                media_cache_entries: entries,
            },
        ))
    }
}

#[test]
fn retained_verified_bytes_survive_source_removal_but_not_eviction_or_job_boundary()
-> Result<(), Box<dyn std::error::Error>> {
    for (bytes, entries) in [(16, 2), (32, 1)] {
        let a = Fixture::new(0.25, false)?;
        let b = Fixture::new(0.75, false)?;
        let mut session = Fixture::session(vec![a.grant.clone(), b.grant.clone()], bytes, entries)?;
        let token = CancellationToken::default();
        let original = session.decode(&a.frame, &a.registry, &token)?;
        std::fs::remove_file(&a.grant.path)?;
        let cached = session.decode(&a.frame, &a.registry, &token)?;
        assert_eq!(original.image.bytes, cached.image.bytes);
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        assert!(matches!(
            session.decode(&a.frame, &a.registry, &cancelled),
            Err(MediaError::Decode(FfmpegError::Cancelled))
        ));
        assert_eq!(session.statistics().hits, 1);
        let mut other_job = Fixture::session(vec![], bytes, entries)?;
        assert!(matches!(
            other_job.decode(&a.frame, &a.registry, &token),
            Err(MediaError::Authorization(_))
        ));
        let different = session.decode(&b.frame, &b.registry, &token)?;
        assert_ne!(different.image.bytes, original.image.bytes);
        assert!(matches!(
            session.decode(&a.frame, &a.registry, &token),
            Err(MediaError::Io(_))
        ));
        let stats = session.statistics();
        assert_eq!(
            (
                stats.decodes,
                stats.evictions,
                stats.entries,
                stats.resident_bytes
            ),
            (2, 1, 1, 16)
        );
    }
    Ok(())
}

#[test]
fn disabled_or_undersized_cache_never_retains_decoded_pixels()
-> Result<(), Box<dyn std::error::Error>> {
    let a = Fixture::new(0.5, false)?;
    for (bytes, entries) in [(0, 2), (15, 2), (32, 0)] {
        let mut session = Fixture::session(vec![a.grant.clone()], bytes, entries)?;
        let token = CancellationToken::default();
        let first = session.decode(&a.frame, &a.registry, &token)?;
        let second = session.decode(&a.frame, &a.registry, &token)?;
        assert_eq!(first.image.bytes, second.image.bytes);
        let stats = session.statistics();
        assert_eq!(
            (
                stats.decodes,
                stats.hits,
                stats.entries,
                stats.resident_bytes
            ),
            (2, 0, 0, 0)
        );
    }
    Ok(())
}

#[test]
fn production_sha256_identity_decodes_verified_source() -> Result<(), Box<dyn std::error::Error>> {
    let a = Fixture::new(0.5, true)?;
    let mut session = Fixture::session(vec![a.grant.clone()], 32, 2)?;
    let decoded = session.decode(&a.frame, &a.registry, &CancellationToken::default())?;
    assert_eq!(decoded.image.receipt.source_sha256, a.grant.sha256);
    assert_eq!(decoded.image.bytes.len(), 16);
    assert_eq!(session.statistics().decodes, 1);
    Ok(())
}

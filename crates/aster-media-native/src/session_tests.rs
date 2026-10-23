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
    fn install(&self, registry: &mut ResourceRegistry) -> Result<(), Box<dyn std::error::Error>> {
        for (hash, kind) in [
            (&self.grant.source, ResourceKind::MediaSource),
            (&self.frame, ResourceKind::MediaFrame),
        ] {
            registry.put(
                PutResource {
                    hash: hash.clone(),
                    kind,
                    descriptor: self.registry.descriptor(hash)?.clone(),
                },
                self.registry.resolve(hash)?.to_vec(),
            )?;
        }
        Ok(())
    }

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
fn portable_snapshot_decodes_identically_after_original_file_removal()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new(0.375, true)?;
    let token = CancellationToken::default();
    let mut disk = Fixture::session(vec![fixture.grant.clone()], 1024, 2)?;
    let expected = disk.decode(&fixture.frame, &fixture.registry, &token)?;
    let snapshot = crate::MediaSnapshotAuthorization {
        source: fixture.grant.source.clone(),
        sequence_frame: None,
        scope: fixture.grant.scope.clone(),
        bytes: std::fs::read(&fixture.grant.path)?.into(),
        sha256: fixture.grant.sha256.clone(),
    };
    std::fs::remove_file(&fixture.grant.path)?;
    let still = NativeStillDecoder::with_snapshots(
        PathBuf::from("unused-for-exr"),
        vec![],
        vec![snapshot],
        crate::SnapshotGrantLimits::default(),
        StillLimits {
            still_max_source_bytes: 1_048_576,
            still_max_pixel_bytes: 1024,
            still_max_dimension: 32,
            still_timeout_ms: 1000,
            still_max_header_bytes: 65536,
        },
    )?;
    let mut memory = NativeMediaSession::new(
        still,
        None,
        MediaCacheLimits {
            media_cache_bytes: 1024,
            media_cache_entries: 2,
        },
    );
    let actual = memory.decode(&fixture.frame, &fixture.registry, &token)?;
    assert_eq!(actual.pixels.request(), expected.pixels.request());
    assert_eq!(actual.pixels.bytes(), expected.pixels.bytes());
    assert_eq!(actual.receipt.source_sha256, expected.receipt.source_sha256);
    assert_eq!(actual.receipt.rgba_sha256, expected.receipt.rgba_sha256);
    Ok(())
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
        assert_eq!(original.pixels.bytes(), cached.pixels.bytes());
        assert_eq!(
            original.pixels.bytes().as_ptr(),
            cached.pixels.bytes().as_ptr()
        );
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
        assert_ne!(different.pixels.bytes(), original.pixels.bytes());
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
        assert_eq!(first.pixels.bytes(), second.pixels.bytes());
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
    assert_eq!(decoded.receipt.source_sha256, a.grant.sha256);
    assert_eq!(decoded.pixels.bytes().len(), 16);
    assert_eq!(session.statistics().decodes, 1);
    Ok(())
}

#[test]
fn oversized_batch_keeps_requested_hits_without_leaking_protection()
-> Result<(), Box<dyn std::error::Error>> {
    for (bytes, entries) in [(32, 256), (1024, 2)] {
        let a = Fixture::new(0.25, true)?;
        let b = Fixture::new(0.5, true)?;
        let c = Fixture::new(0.75, true)?;
        let d = Fixture::new(1.0, true)?;
        let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
        for fixture in [&a, &b, &c, &d] {
            fixture.install(&mut registry)?;
        }
        let mut session = Fixture::session(
            vec![
                a.grant.clone(),
                b.grant.clone(),
                c.grant.clone(),
                d.grant.clone(),
            ],
            bytes,
            entries,
        )?;
        let token = CancellationToken::default();
        let original =
            session.decode_batch(&[a.frame.clone(), b.frame.clone()], &registry, &token)?;
        std::fs::remove_file(&a.grant.path)?;
        std::fs::remove_file(&b.grant.path)?;
        let hashes = [c.frame.clone(), a.frame.clone(), b.frame.clone()];
        for _ in 0..2 {
            let batch = session.decode_batch(&hashes, &registry, &token)?;
            assert_eq!(batch.len(), 3);
            for i in 0..2 {
                assert_eq!(batch[i + 1].pixels.bytes(), original[i].pixels.bytes());
                assert_eq!(
                    batch[i + 1].pixels.bytes().as_ptr(),
                    original[i].pixels.bytes().as_ptr()
                );
            }
        }
        let stats = session.statistics();
        assert_eq!((stats.decodes, stats.hits, stats.evictions), (4, 4, 0));
        assert_eq!((stats.resident_bytes, stats.entries), (32, 2));
        let cancelled = CancellationToken::default();
        cancelled.cancel();
        assert!(matches!(
            session.decode_batch(&hashes, &registry, &cancelled),
            Err(MediaError::Decode(FfmpegError::Cancelled))
        ));
        std::fs::remove_file(&c.grant.path)?;
        assert!(matches!(
            session.decode_batch(&hashes, &registry, &token),
            Err(MediaError::Io(_))
        ));
        session.decode(&d.frame, &registry, &token)?;
        assert_eq!(session.statistics().evictions, 1);
        assert!(matches!(
            session.decode(&a.frame, &registry, &token),
            Err(MediaError::Io(_))
        ));
    }
    Ok(())
}

#[test]
fn incremental_authorization_preserves_shared_frame_cache_and_rejects_unknown_sources()
-> Result<(), Box<dyn std::error::Error>> {
    let first = Fixture::new(0.25, true)?;
    let second = Fixture::new(0.75, true)?;
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    first.install(&mut registry)?;
    second.install(&mut registry)?;
    let mut session = Fixture::session(vec![first.grant.clone()], 1024, 2)?;
    let cancellation = CancellationToken::default();
    let original = session.decode(&first.frame, &registry, &cancellation)?;
    assert!(
        session
            .decode(&second.frame, &registry, &cancellation)
            .is_err()
    );
    session.admit_grants(
        vec![second.grant.clone()],
        Vec::new(),
        crate::SnapshotGrantLimits::default(),
    )?;
    session.decode(&second.frame, &registry, &cancellation)?;
    let repeated = session.decode(&first.frame, &registry, &cancellation)?;
    assert_eq!(original.pixels.bytes(), repeated.pixels.bytes());
    assert_eq!(session.statistics().decodes, 2);
    assert_eq!(session.statistics().hits, 1);
    assert_eq!(session.statistics().entries, 2);
    assert!(
        session
            .admit_grants(
                vec![first.grant.clone()],
                Vec::new(),
                crate::SnapshotGrantLimits::default()
            )
            .is_err()
    );
    Ok(())
}

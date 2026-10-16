use crate::{MediaError, NativeStillDecoder, StillAuthorization, StillLimits};
use aster_render_ir::{
    CompositionIdentity, MediaFrameDescriptor, MediaKind, MediaSample, MediaSourceDescriptor,
    MediaTextureFormat, PutResource, ResourceDescriptor, ResourceHash, ResourceKind,
    ResourceLimits, ResourceRegistry,
};
use aster_video::{CancellationToken, FfmpegError};
use std::path::PathBuf;

struct Fixture {
    registry: ResourceRegistry,
    frame: ResourceHash,
    grant: StillAuthorization,
}

impl Fixture {
    fn new(sample: MediaSample) -> Result<Self, MediaError> {
        let sequence_frame = match &sample {
            MediaSample::Sequence { frame, .. } => Some(*frame),
            _ => None,
        };
        let descriptor = ResourceDescriptor::MediaSource(MediaSourceDescriptor {
            source_id: CompositionIdentity::Unicode("fixture".into()),
            content_identity: "fnv64:0000000000000000:0".into(),
            authorization_scope: "job:still".into(),
            media_kind: if sequence_frame.is_some() {
                MediaKind::Sequence
            } else {
                MediaKind::Image
            },
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
            sample,
            width: 16,
            height: 8,
            format: MediaTextureFormat::Rgba8UnormSrgb,
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
        Ok(Self {
            registry,
            frame,
            grant: StillAuthorization {
                source,
                sequence_frame,
                scope: "job:still".into(),
                path: std::env::temp_dir().join(format!("aster-still-{}", uuid::Uuid::new_v4())),
                sha256: "0".repeat(64),
            },
        })
    }

    fn limits() -> StillLimits {
        StillLimits {
            still_max_source_bytes: 1024,
            still_max_pixel_bytes: 1024,
            still_max_dimension: 32,
            still_timeout_ms: 100,
            still_max_header_bytes: 1024,
        }
    }

    fn decoder(
        &self,
        grants: Vec<StillAuthorization>,
        limits: StillLimits,
    ) -> Result<NativeStillDecoder, MediaError> {
        NativeStillDecoder::new(PathBuf::from("nonexistent-ffmpeg"), grants, limits)
    }
}

#[test]
fn authorization_and_limits_precede_file_access() -> Result<(), MediaError> {
    let fixture = Fixture::new(MediaSample::Image)?;
    let token = CancellationToken::default();
    let missing = fixture.decoder(vec![], Fixture::limits())?;
    assert!(matches!(
        missing.decode(&fixture.frame, &fixture.registry, &token),
        Err(MediaError::Authorization(_))
    ));
    let mut wrong = fixture.grant.clone();
    wrong.scope = "other-job".into();
    let wrong = fixture.decoder(vec![wrong], Fixture::limits())?;
    assert!(matches!(
        wrong.decode(&fixture.frame, &fixture.registry, &token),
        Err(MediaError::Authorization(_))
    ));
    let tiny = fixture.decoder(
        vec![fixture.grant.clone()],
        StillLimits {
            still_max_pixel_bytes: 32,
            ..Fixture::limits()
        },
    )?;
    assert!(matches!(
        tiny.decode(&fixture.frame, &fixture.registry, &token),
        Err(MediaError::Limit(_))
    ));
    let cancelled = fixture.decoder(vec![fixture.grant.clone()], Fixture::limits())?;
    token.cancel();
    assert!(matches!(
        cancelled.decode(&fixture.frame, &fixture.registry, &token),
        Err(MediaError::Decode(FfmpegError::Cancelled))
    ));
    assert_eq!(fixture.registry.statistics().resources, 2);
    Ok(())
}

#[test]
fn changed_file_identity_and_duplicate_grants_are_rejected() -> Result<(), MediaError> {
    let fixture = Fixture::new(MediaSample::Image)?;
    assert!(matches!(
        fixture.decoder(
            vec![fixture.grant.clone(), fixture.grant.clone()],
            Fixture::limits()
        ),
        Err(MediaError::Authorization(_))
    ));
    std::fs::write(&fixture.grant.path, b"changed")?;
    let result = fixture
        .decoder(vec![fixture.grant.clone()], Fixture::limits())?
        .decode(
            &fixture.frame,
            &fixture.registry,
            &CancellationToken::default(),
        );
    std::fs::remove_file(&fixture.grant.path)?;
    assert!(matches!(result, Err(MediaError::Identity)));
    Ok(())
}

#[test]
fn sha_and_legacy_identities_require_fresh_granted_bytes() -> Result<(), MediaError> {
    use crate::authorization::MediaGrants;
    use sha2::{Digest, Sha256};

    let fixture = Fixture::new(MediaSample::Image)?;
    let bytes = b"identity-fixture";
    std::fs::write(&fixture.grant.path, bytes)?;
    let mut grant = fixture.grant.clone();
    grant.sha256 = format!("{:x}", Sha256::digest(bytes));
    let identity = format!("sha256:{}", grant.sha256);
    let grants = MediaGrants::new(vec![grant.clone()])?;
    let token = CancellationToken::default();
    let read =
        |identity: &str| grants.read(&grant.source, &grant.scope, None, identity, 1024, &token);
    let modern = read(&identity);
    let legacy = read("fnv64:5ec517ef189ba6b3:16");
    let invalid = read("sha256:0000000000000000000000000000000000000000000000000000000000000000");
    let ungranted = MediaGrants::new(vec![fixture.grant.clone()])?.read(
        &grant.source,
        &grant.scope,
        None,
        &identity,
        1024,
        &token,
    );
    std::fs::write(&fixture.grant.path, b"modified-fixture")?;
    let changed_modern = read(&identity);
    let changed_legacy = read("fnv64:5ec517ef189ba6b3:16");
    std::fs::remove_file(&fixture.grant.path)?;
    assert_eq!(modern?.bytes, bytes);
    assert_eq!(legacy?.bytes, bytes);
    for rejected in [invalid, ungranted, changed_modern, changed_legacy] {
        assert!(matches!(rejected, Err(MediaError::Identity)));
    }
    Ok(())
}

#[test]
fn canvas_precision_clears_hidden_rgb_and_preserves_opaque_samples() {
    let mut pixels = [255, 0, 128, 0, 12, 34, 56, 255, 120, 12, 250, 3];
    NativeStillDecoder::canvas_alpha_precision(&mut pixels);
    assert_eq!(pixels, [0, 0, 0, 0, 12, 34, 56, 255, 85, 0, 255, 3]);
}

#[test]
fn canvas_precision_matches_integer_roundtrip_for_every_channel_and_alpha() {
    let mut pixels = Vec::new();
    let mut expected = Vec::new();
    for alpha in 0_u32..=255 {
        for channel in 0_u32..=255 {
            pixels.extend_from_slice(&[channel as u8, channel as u8, channel as u8, alpha as u8]);
            let associated = (channel * alpha + 127) / 255;
            let restored = (associated * 255 + alpha / 2)
                .checked_div(alpha)
                .map_or(0, |value| value as u8);
            expected.extend_from_slice(&[restored, restored, restored, alpha as u8]);
        }
    }
    NativeStillDecoder::canvas_alpha_precision(&mut pixels);
    assert_eq!(pixels, expected);
}

#[test]
fn sequence_grants_bind_exact_members_and_verify_member_bytes()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new(MediaSample::Sequence {
        frame: 3,
        file_identity: "fnv64:0000000000000000:0".into(),
    })?;
    let token = CancellationToken::default();
    for member in [None, Some(2), Some(4)] {
        let mut grant = fixture.grant.clone();
        grant.sequence_frame = member;
        assert!(matches!(
            fixture.decoder(vec![grant], Fixture::limits())?.decode(
                &fixture.frame,
                &fixture.registry,
                &token
            ),
            Err(MediaError::Authorization(_))
        ));
    }
    let mut other = fixture.grant.clone();
    other.sequence_frame = Some(4);
    fixture.decoder(vec![fixture.grant.clone(), other], Fixture::limits())?;
    assert!(matches!(
        fixture.decoder(
            vec![fixture.grant.clone(), fixture.grant.clone()],
            Fixture::limits()
        ),
        Err(MediaError::Authorization(_))
    ));
    let bytes = b"different member";
    std::fs::write(&fixture.grant.path, bytes)?;
    let mut grant = fixture.grant.clone();
    use sha2::{Digest, Sha256};
    grant.sha256 = format!("{:x}", Sha256::digest(bytes));
    let result = fixture.decoder(vec![grant], Fixture::limits())?.decode(
        &fixture.frame,
        &fixture.registry,
        &token,
    );
    std::fs::remove_file(&fixture.grant.path)?;
    assert!(matches!(result, Err(MediaError::Identity)));
    assert_eq!(fixture.registry.statistics().resources, 2);
    Ok(())
}

use crate::{
    CompositionIdentity, FrameTime, IrError, MediaFrameDescriptor, MediaKind, MediaSample,
    MediaSourceDescriptor, MediaTextureFormat, PutResource, ResourceDescriptor, ResourceHash,
    ResourceKind, ResourceLimits, ResourceRegistry, VerifiedResource,
};

struct MediaFixture;

impl MediaFixture {
    fn requests() -> Result<(PutResource, PutResource), IrError> {
        let source = ResourceDescriptor::MediaSource(MediaSourceDescriptor {
            source_id: CompositionIdentity::Unicode("媒体/video/🎬".to_owned()),
            content_identity: "opaque-import:video".to_owned(),
            authorization_scope: "render-job:test".to_owned(),
            media_kind: MediaKind::Video,
        });
        let hash = ResourceHash::for_resource(ResourceKind::MediaSource, &source, &[])?;
        let frame = ResourceDescriptor::MediaFrame(MediaFrameDescriptor {
            source: hash.clone(),
            sample: MediaSample::Video {
                requested_time: FrameTime::from_f64(1001.0 / 24000.0)?,
                uploaded_time: FrameTime::from_f64(1001.0 / 24000.0 + 0.0001)?,
            },
            width: 1920,
            height: 1080,
            format: MediaTextureFormat::Rgba8UnormSrgb,
        });
        Ok((
            PutResource {
                hash,
                kind: ResourceKind::MediaSource,
                descriptor: source,
            },
            PutResource {
                hash: ResourceHash::for_resource(ResourceKind::MediaFrame, &frame, &[])?,
                kind: ResourceKind::MediaFrame,
                descriptor: frame,
            },
        ))
    }
}

#[test]
fn retained_media_proofs_preserve_exact_descriptor_charge_and_per_registry_dependencies()
-> Result<(), IrError> {
    let (source, frame) = MediaFixture::requests()?;
    let source_bytes = crate::canonical::CanonicalJson::encode(&source.descriptor)?.len() as u64;
    let frame_bytes = crate::canonical::CanonicalJson::encode(&frame.descriptor)?.len() as u64;
    let source = VerifiedResource::new(source.kind, source.descriptor, vec![])?;
    let frame = VerifiedResource::new(frame.kind, frame.descriptor, vec![])?;
    let limits = ResourceLimits {
        budget_bytes: source_bytes + frame_bytes,
        ..Default::default()
    };
    let mut first = ResourceRegistry::new(limits.clone())?;
    let mut second = ResourceRegistry::new(limits)?;
    first.put_verified(source.clone())?;
    first.put_verified(frame.clone())?;
    assert_eq!(first.statistics().used_bytes, source_bytes + frame_bytes);
    assert!(matches!(
        second.put_verified(frame.clone()),
        Err(IrError::MissingResource(_))
    ));
    assert_eq!(second.statistics().used_bytes, 0);
    for registry in [&mut first, &mut second] {
        registry.put_verified(source.clone())?;
        registry.put_verified(frame.clone())?;
        assert!(std::ptr::eq(
            registry.descriptor(&frame.request().hash)?,
            &frame.request().descriptor
        ));
        assert!(matches!(
            registry.evict(&source.request().hash),
            Err(IrError::ResourceInUse(_))
        ));
        registry.evict(&frame.request().hash)?;
        assert_eq!(registry.statistics().used_bytes, source_bytes);
        registry.evict(&source.request().hash)?;
        assert_eq!(registry.statistics().used_bytes, 0);
        registry.put_verified(source.clone())?;
        registry.put_verified(frame.clone())?;
        assert_eq!(registry.statistics().used_bytes, source_bytes + frame_bytes);
    }
    let mut tiny = ResourceRegistry::new(ResourceLimits {
        budget_bytes: source_bytes - 1,
        ..Default::default()
    })?;
    assert!(matches!(
        tiny.put_verified(source),
        Err(IrError::ResourceBudgetExceeded { .. })
    ));
    assert_eq!(tiny.statistics().used_bytes, 0);
    Ok(())
}

#[test]
fn media_dependencies_outlive_frames_and_in_flight_leases() -> Result<(), IrError> {
    let (source, frame) = MediaFixture::requests()?;
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    assert!(matches!(
        registry.put(frame.clone(), vec![]),
        Err(IrError::MissingResource(_))
    ));
    assert_eq!(registry.statistics().used_bytes, 0);
    registry.put(source.clone(), vec![])?;
    registry.put(frame.clone(), vec![])?;
    registry.put(frame.clone(), vec![])?;
    assert_eq!(registry.descriptor(&frame.hash)?, &frame.descriptor);
    assert!(matches!(
        registry.evict(&source.hash),
        Err(IrError::ResourceInUse(_))
    ));
    let lease = registry.pin(std::slice::from_ref(&frame.hash))?;
    assert!(matches!(
        registry.evict(&frame.hash),
        Err(IrError::ResourceInUse(_))
    ));
    registry.release(&lease)?;
    registry.evict(&frame.hash)?;
    registry.evict(&source.hash)?;
    assert_eq!(registry.statistics().used_bytes, 0);
    assert!(matches!(
        registry.descriptor(&frame.hash),
        Err(IrError::MissingResource(_))
    ));
    Ok(())
}

#[test]
fn media_hashes_validate_kind_time_payload_and_admission_budget() -> Result<(), IrError> {
    let (source, frame) = MediaFixture::requests()?;
    assert!(ResourceHash::for_resource(ResourceKind::MediaFrame, &source.descriptor, &[]).is_err());
    assert!(ResourceHash::for_resource(source.kind, &source.descriptor, &[1]).is_err());
    let mut tiny = ResourceRegistry::new(ResourceLimits {
        budget_bytes: 1,
        ..ResourceLimits::default()
    })?;
    assert!(matches!(
        tiny.put(source.clone(), vec![]),
        Err(IrError::ResourceBudgetExceeded { .. })
    ));
    assert_eq!(tiny.statistics().resources, 0);
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    registry.put(source, vec![])?;
    let mut wrong = frame.clone();
    wrong.hash = ResourceHash("0".repeat(64));
    assert!(matches!(
        registry.put(wrong, vec![]),
        Err(IrError::HashMismatch)
    ));
    let mut altered = frame;
    if let ResourceDescriptor::MediaFrame(descriptor) = &mut altered.descriptor {
        descriptor.sample = MediaSample::Sequence {
            frame: 0,
            file_identity: "member:0".to_owned(),
        };
    }
    altered.hash = ResourceHash::for_resource(altered.kind, &altered.descriptor, &[])?;
    assert!(matches!(
        registry.put(altered, vec![]),
        Err(IrError::ResourceConflict)
    ));
    assert_eq!(registry.statistics().resources, 1);
    Ok(())
}

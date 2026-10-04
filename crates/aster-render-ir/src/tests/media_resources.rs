use crate::{
    CompositionIdentity, FrameTime, IrError, MediaFrameDescriptor, MediaKind, MediaSample,
    MediaSourceDescriptor, MediaTextureFormat, PutResource, ResourceDescriptor, ResourceHash,
    ResourceKind, ResourceLimits, ResourceRegistry,
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

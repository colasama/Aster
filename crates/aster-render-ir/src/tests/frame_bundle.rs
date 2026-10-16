use super::Fixture;
use crate::{
    BufferResourceDescriptor, BundleDependencies, ContractLevel, DecodeLimits, ElementType,
    FplnCodec, FrameBundleSlice, IrError, PlanSlice, PrecompositionMediaPixels, ResourceDescriptor,
    ResourceHash, ResourceKind, ResourceLimits, ResourceRegistry, VerifiedResource,
};

#[test]
fn dependency_modes_preserve_canonical_and_closure_rejections() -> Result<(), IrError> {
    let fixture = Fixture::new()?;
    let canonical = fixture.encode()?;
    let mut flags = canonical.clone();
    flags[24] = 1;
    let mut padding = canonical.clone();
    let header = crate::wire::WireHeader::read(&padding)?;
    padding[32 + header.metadata_bytes as usize] = 1;
    let mut json = vec![b' '];
    json.extend(crate::canonical::CanonicalJson::encode(&fixture.metadata)?);
    let noncanonical = Fixture::unchecked_json(&json, &fixture.blobs)?;
    let limits = DecodeLimits::default();
    for (index, bytes) in [canonical, flags, padding, noncanonical]
        .into_iter()
        .enumerate()
    {
        let length = u32::try_from(bytes.len()).map_err(|_| IrError::ArithmeticOverflow)?;
        let resource = VerifiedResource::new(
            ResourceKind::Buffer,
            ResourceDescriptor::Buffer(BufferResourceDescriptor {
                element_type: ElementType::U8,
                element_count: length,
                byte_length: length,
            }),
            bytes,
        )?;
        let hash = resource.request().hash.clone();
        let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
        registry.put_verified(resource)?;
        let mut root = fixture.metadata.clone();
        root.contract_level = ContractLevel::FrameBundleSliceV1;
        root.renderer_plan_complete = true;
        root.resources.push(hash.clone());
        root.resources.sort();
        root.blobs.truncate(1);
        root.blobs[0].element_type = ElementType::U32Le;
        root.blobs[0].byte_length = 24;
        root.blobs[0].element_count = 6;
        root.slices = vec![PlanSlice::FrameBundle(FrameBundleSlice {
            blob_index: 0,
            scene: hash.clone(),
            root: hash.clone(),
            post: hash.clone(),
            motion: hash.clone(),
            output: hash,
            auxiliary: None,
            effect: None,
            precompositions: None,
            shadow_map_size: 1024,
            effects: Vec::new(),
            generators: Vec::new(),
            media_pixels: Vec::new(),
            temporal: Vec::new(),
        })];
        root.validate(&limits)?;
        for audit in [false, true] {
            let dependencies = if audit {
                BundleDependencies::default().with_roundtrip()
            } else {
                BundleDependencies::default()
            };
            let result = dependencies.validate(&root, &registry, &limits);
            if index == 0 {
                assert_eq!(result?, 1);
            } else {
                assert!(result.is_err());
            }
        }
        let mut visited = Vec::new();
        let result = BundleDependencies::default().validate_with(
            &root,
            &registry,
            &limits,
            |hash, plan, bytes| visited.push((hash, plan, bytes)),
        );
        if index == 0 {
            assert_eq!(result?, 1);
            assert_eq!(visited.len(), 1);
            let (hash, plan, length) = &visited[0];
            assert_eq!(plan.reencode(&limits)?, registry.resolve(hash)?);
            assert_eq!(*length, registry.resolve(hash)?.len());
        } else {
            assert!(result.is_err());
            assert!(visited.is_empty());
        }
        root.resources
            .retain(|hash| !fixture.metadata.resources.contains(hash));
        for dependencies in [
            BundleDependencies::default(),
            BundleDependencies::default().with_roundtrip(),
        ] {
            assert!(dependencies.validate(&root, &registry, &limits).is_err());
        }
    }
    Ok(())
}

#[test]
fn root_bundle_uses_typed_count_payload_and_requires_declared_stages() -> Result<(), IrError> {
    let mut metadata = Fixture::new()?.metadata;
    let stage = ResourceHash("a".repeat(64));
    metadata.contract_level = ContractLevel::FrameBundleSliceV1;
    metadata.renderer_plan_complete = true;
    metadata.resources = vec![stage.clone()];
    metadata.blobs.truncate(1);
    metadata.blobs[0].element_type = ElementType::U32Le;
    metadata.blobs[0].byte_length = 24;
    metadata.blobs[0].element_count = 6;
    metadata.slices = vec![PlanSlice::FrameBundle(FrameBundleSlice {
        blob_index: 0,
        scene: stage.clone(),
        root: stage.clone(),
        post: stage.clone(),
        motion: stage.clone(),
        output: stage,
        auxiliary: None,
        effect: None,
        precompositions: None,
        shadow_map_size: 1024,
        effects: Vec::new(),
        generators: Vec::new(),
        media_pixels: Vec::new(),
        temporal: Vec::new(),
    })];
    let bytes: Vec<u8> = [1024_u32, 0, 0, 0, 0, 0]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect();
    let limits = DecodeLimits::default();
    let mut incomplete = metadata.clone();
    incomplete.renderer_plan_complete = false;
    assert!(matches!(
        FplnCodec::encode(incomplete, &[&bytes], &limits),
        Err(IrError::IncompleteFramePlan)
    ));
    let encoded = FplnCodec::encode(metadata.clone(), &[&bytes], &limits)?;
    assert_eq!(
        FplnCodec::decode(encoded.clone(), &limits)?.reencode(&limits)?,
        encoded
    );
    let mut wrong_count = bytes.clone();
    wrong_count[4] = 1;
    assert!(matches!(
        FplnCodec::encode(metadata.clone(), &[&wrong_count], &limits),
        Err(IrError::InvalidHeader(_))
    ));
    let mut captured = metadata.clone();
    if let PlanSlice::FrameBundle(bundle) = &mut captured.slices[0] {
        bundle.media_pixels.push(PrecompositionMediaPixels {
            frame: bundle.scene.clone(),
            pixels: bundle.scene.clone(),
        });
    }
    let mut capture_bytes = bytes.clone();
    capture_bytes[16] = 1;
    let captured_bytes = FplnCodec::encode(captured.clone(), &[&capture_bytes], &limits)?;
    assert_eq!(
        FplnCodec::decode(captured_bytes.clone(), &limits)?.reencode(&limits)?,
        captured_bytes
    );
    if let PlanSlice::FrameBundle(bundle) = &mut captured.slices[0] {
        bundle.media_pixels.push(bundle.media_pixels[0].clone());
    }
    capture_bytes[16] = 2;
    assert!(matches!(
        FplnCodec::encode(captured, &[&capture_bytes], &limits),
        Err(IrError::InvalidResource(_))
    ));
    let mut temporal = metadata.clone();
    if let PlanSlice::FrameBundle(bundle) = &mut temporal.slices[0] {
        bundle.temporal.push(bundle.scene.clone());
    }
    let mut temporal_bytes = bytes.clone();
    temporal_bytes[20] = 1;
    let encoded = FplnCodec::encode(temporal.clone(), &[&temporal_bytes], &limits)?;
    assert_eq!(
        FplnCodec::decode(encoded.clone(), &limits)?.reencode(&limits)?,
        encoded
    );
    if let PlanSlice::FrameBundle(bundle) = &mut temporal.slices[0] {
        bundle.temporal.push(bundle.temporal[0].clone());
    }
    temporal_bytes[20] = 2;
    assert!(matches!(
        FplnCodec::encode(temporal, &[&temporal_bytes], &limits),
        Err(IrError::InvalidResource(_))
    ));
    metadata.resources.clear();
    assert!(matches!(
        FplnCodec::encode(metadata, &[&bytes], &limits),
        Err(IrError::MissingResource(_))
    ));
    Ok(())
}

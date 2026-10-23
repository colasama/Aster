use crate::frame_plans::FramePlans;
use aster_render_ir::{
    BufferResourceDescriptor, ContractLevel, DecodeLimits, ElementType, FplnCodec,
    FrameBundleSlice, FramePlanSliceV1, IrFixture, PlanSlice, ResourceDescriptor, ResourceHash,
    ResourceKind, ResourceRegistry, VerifiedResource,
};
use std::sync::Arc;

struct PlansFixture {
    root: FramePlanSliceV1,
    registry: ResourceRegistry,
    hashes: Vec<ResourceHash>,
    max_bytes: usize,
}

impl PlansFixture {
    fn new(invalid: bool, native: bool) -> Result<Self, Box<dyn std::error::Error>> {
        let (metadata, blobs) = IrFixture::parts()?;
        let limits = DecodeLimits::default();
        let mut registry = ResourceRegistry::new(Default::default())?;
        let mut hashes = Vec::new();
        let mut max_bytes = 0;
        for revision in [1, 2] {
            let mut stage = metadata.clone();
            stage.header.project_revision = revision;
            let mut bytes = FplnCodec::encode(
                stage.clone(),
                &blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                &limits,
            )?;
            if invalid && revision == 2 {
                bytes[24] = 1;
            }
            max_bytes = max_bytes.max(bytes.len());
            let length = u32::try_from(bytes.len())?;
            let resource = if native {
                VerifiedResource::from_plan(
                    stage,
                    &blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
                    &limits,
                )?
            } else {
                VerifiedResource::new(
                    ResourceKind::Buffer,
                    ResourceDescriptor::Buffer(BufferResourceDescriptor {
                        element_type: ElementType::U8,
                        element_count: length,
                        byte_length: length,
                    }),
                    bytes,
                )?
            };
            hashes.push(resource.request().hash.clone());
            registry.put_verified(resource)?;
        }
        let mut root = metadata;
        root.contract_level = ContractLevel::FrameBundleSliceV1;
        root.renderer_plan_complete = true;
        root.resources.extend(hashes.clone());
        root.resources.sort();
        root.slices = vec![PlanSlice::FrameBundle(FrameBundleSlice {
            blob_index: 0,
            scene: hashes[0].clone(),
            root: hashes[1].clone(),
            post: hashes[0].clone(),
            motion: hashes[0].clone(),
            output: hashes[1].clone(),
            auxiliary: None,
            effect: None,
            precompositions: None,
            shadow_map_size: 1024,
            effects: Vec::new(),
            generators: Vec::new(),
            media_pixels: Vec::new(),
            temporal: Vec::new(),
        })];
        Ok(Self {
            root,
            registry,
            hashes,
            max_bytes,
        })
    }
}

#[test]
fn decoded_plans_share_immutable_ownership_and_bound_retention_without_rejecting_frames()
-> Result<(), Box<dyn std::error::Error>> {
    for native in [false, true] {
        let fixture = PlansFixture::new(false, native)?;
        for bounded in [false, true] {
            let limits = if bounded {
                DecodeLimits {
                    max_container_bytes: fixture.max_bytes,
                    max_metadata_bytes: fixture.max_bytes,
                    ..Default::default()
                }
            } else {
                DecodeLimits::default()
            };
            let plans = FramePlans::new(&fixture.root, &fixture.registry, &limits)?;
            let mut reused = 0;
            for hash in &fixture.hashes {
                let mut first = plans.resolve(hash, &fixture.registry)?;
                let second = plans.resolve(hash, &fixture.registry)?;
                reused += usize::from(Arc::ptr_eq(&first, &second));
                assert!(Arc::get_mut(&mut first).is_none() || bounded);
                assert_eq!(first.reencode(&limits)?, fixture.registry.resolve(hash)?);
                assert_eq!(second.reencode(&limits)?, fixture.registry.resolve(hash)?);
            }
            assert_eq!(reused, if bounded && !native { 1 } else { 2 });
            assert!(
                plans
                    .resolve(&ResourceHash("f".repeat(64)), &fixture.registry)
                    .is_err()
            );
        }
    }
    Ok(())
}

#[test]
fn decoded_plan_reuse_never_bypasses_closure_or_container_validation()
-> Result<(), Box<dyn std::error::Error>> {
    let limits = DecodeLimits::default();
    let bad = PlansFixture::new(true, false)?;
    assert!(FramePlans::new(&bad.root, &bad.registry, &limits).is_err());
    for native in [false, true] {
        let mut fixture = PlansFixture::new(false, native)?;
        fixture.root.resources = fixture.hashes.clone();
        assert!(FramePlans::new(&fixture.root, &fixture.registry, &limits).is_err());
        let fixture = PlansFixture::new(false, native)?;
        let strict = DecodeLimits {
            max_blobs: 1,
            ..limits.clone()
        };
        assert!(FramePlans::new(&fixture.root, &fixture.registry, &strict).is_err());
    }
    Ok(())
}

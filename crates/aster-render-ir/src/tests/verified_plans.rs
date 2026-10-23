use std::sync::Arc;

use crate::{
    BufferResourceDescriptor, DecodeLimits, ElementType, FplnCodec, IrError, ResourceDescriptor,
    ResourceKind, ResourceRegistry, VerifiedResource,
};

use super::Fixture;

struct PlanFixture;

#[test]
fn proof_remembers_actual_constructor_limits_and_rechecks_changed_limits() -> Result<(), IrError> {
    let mut fixture = Fixture::new()?;
    fixture.metadata.resources.clear();
    fixture.metadata.header.render_target.width = 20_000;
    for blob in &mut fixture.blobs {
        blob[..4].copy_from_slice(&20_000_f32.to_le_bytes());
    }
    let limits = DecodeLimits {
        max_dimension: 20_000,
        max_resource_references: 0,
        ..Default::default()
    };
    let borrowed = fixture.blobs.iter().map(Vec::as_slice).collect::<Vec<_>>();
    assert!(
        VerifiedResource::from_plan(
            fixture.metadata.clone(),
            &borrowed,
            &DecodeLimits::default(),
        )
        .is_err()
    );
    let proof = VerifiedResource::from_plan(fixture.metadata, &borrowed, &limits)?;
    let hash = proof.request().hash.clone();
    let mut registry = ResourceRegistry::new(Default::default())?;
    registry.put_verified(proof)?;
    let first = registry.resolve_plan(&hash, &limits)?;
    assert!(
        registry
            .resolve_plan(&hash, &DecodeLimits::default())
            .is_err()
    );
    let larger = DecodeLimits {
        max_dimension: 21_000,
        ..limits.clone()
    };
    let second = registry.resolve_plan(&hash, &larger)?;
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(first.reencode(&limits)?, registry.resolve(&hash)?);
    let invalid = DecodeLimits {
        max_metadata_bytes: 0,
        ..limits
    };
    assert!(registry.resolve_plan(&hash, &invalid).is_err());
    Ok(())
}

impl PlanFixture {
    fn raw(bytes: Vec<u8>) -> Result<VerifiedResource, IrError> {
        let length = u32::try_from(bytes.len()).map_err(|_| IrError::ArithmeticOverflow)?;
        VerifiedResource::new(
            ResourceKind::Buffer,
            ResourceDescriptor::Buffer(BufferResourceDescriptor {
                element_type: ElementType::U8,
                element_count: length,
                byte_length: length,
            }),
            bytes,
        )
    }
}

#[test]
fn native_plan_proofs_keep_wire_identity_and_immutable_resource_ownership() -> Result<(), IrError> {
    let mut fixture = Fixture::new()?;
    let bytes = fixture.encode()?;
    let limits = DecodeLimits::default();
    let proof = VerifiedResource::from_plan(
        fixture.metadata.clone(),
        &fixture.blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
        &limits,
    )?;
    let raw = PlanFixture::raw(bytes.clone())?;
    assert_eq!(proof.request(), raw.request());
    assert_eq!(proof.bytes(), bytes);
    fixture.metadata.header.project_revision = 0;
    fixture.blobs[0].fill(0);
    let hash = proof.request().hash.clone();
    let mut registry = ResourceRegistry::new(Default::default())?;
    registry.put_verified(proof.clone())?;
    assert_eq!(registry.statistics().used_bytes, bytes.len() as u64);
    let mut first = registry.resolve_plan(&hash, &limits)?;
    let second = registry.resolve_plan(&hash, &limits)?;
    assert!(Arc::ptr_eq(&first, &second));
    assert!(Arc::get_mut(&mut first).is_none());
    assert_eq!(first.reencode(&limits)?, bytes);
    registry.evict(&hash)?;
    drop(second);
    assert!(Arc::get_mut(&mut first).is_none());
    assert_eq!(proof.bytes(), bytes);
    Ok(())
}

#[test]
fn retained_plan_obeys_every_caller_limit_and_external_bytes_still_decode() -> Result<(), IrError> {
    let fixture = Fixture::new()?;
    let bytes = fixture.encode()?;
    let limits = DecodeLimits::default();
    let proof = VerifiedResource::from_plan(
        fixture.metadata.clone(),
        &fixture.blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
        &limits,
    )?;
    let hash = proof.request().hash.clone();
    let mut registry = ResourceRegistry::new(Default::default())?;
    registry.put_verified(proof)?;
    let mut stricter = vec![limits.clone(); 8];
    stricter[0].max_container_bytes = bytes.len() - 1;
    stricter[0].max_metadata_bytes = bytes.len() - 1;
    stricter[1].max_metadata_bytes = 1;
    stricter[2].max_blobs = 1;
    stricter[3].max_slices = 1;
    stricter[4].max_resource_references = 0;
    stricter[5].max_dimension = 639;
    stricter[6].max_pixels = 640 * 360 - 1;
    stricter[7].max_container_bytes = 0;
    for strict in stricter {
        assert!(FplnCodec::decode(bytes.clone(), &strict).is_err());
        assert!(registry.resolve_plan(&hash, &strict).is_err());
    }
    // A valid resource hash authenticates bytes, not their FPLN semantics.
    let mut corrupt = bytes;
    corrupt[24] = 1;
    let raw = PlanFixture::raw(corrupt)?;
    let hash = raw.request().hash.clone();
    registry.put_verified(raw)?;
    assert!(registry.resolve_plan(&hash, &limits).is_err());
    let mut blobs = fixture.blobs;
    blobs[0][0..4].copy_from_slice(&f32::NAN.to_le_bytes());
    assert!(
        VerifiedResource::from_plan(
            fixture.metadata,
            &blobs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
            &limits,
        )
        .is_err()
    );
    Ok(())
}

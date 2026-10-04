use crate::{
    BufferResourceDescriptor, ElementType, IrError, PutOutcome, PutResource, ResourceHash,
    ResourceKind, ResourceLimits, ResourceMessage, ResourceRegistry,
};

use super::Fixture;

struct ResourceFixture;

impl ResourceFixture {
    fn request(bytes: &[u8]) -> Result<PutResource, IrError> {
        let descriptor = BufferResourceDescriptor {
            element_type: ElementType::U8,
            element_count: bytes.len() as u32,
            byte_length: bytes.len() as u32,
        };
        Ok(PutResource {
            hash: ResourceHash::for_buffer(&descriptor, bytes)?,
            kind: ResourceKind::Buffer,
            descriptor: crate::ResourceDescriptor::Buffer(descriptor),
        })
    }
}

#[test]
fn hashes_bind_layout_and_content_and_match_the_independent_wire_vector() -> Result<(), IrError> {
    let input = [1, 2, 3, 4];
    let request = ResourceFixture::request(&input)?;
    assert_eq!(
        request.hash.0,
        "49ef9b421b7eeb4a8198c7fae14b3fe7444a0a23ed6da53f2b70943a787f2aa5"
    );
    let word = BufferResourceDescriptor {
        element_type: ElementType::U32Le,
        element_count: 1,
        byte_length: 4,
    };
    assert_ne!(request.hash, ResourceHash::for_buffer(&word, &input)?);
    let message = ResourceMessage::PutResource(request);
    let json =
        serde_json::to_string(&message).map_err(|error| IrError::InvalidJson(error.to_string()))?;
    assert!(json.contains("\"type\":\"put_resource\""));
    assert_eq!(
        serde_json::from_str::<ResourceMessage>(&json)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?,
        message
    );
    assert!(
        serde_json::from_str::<ResourceMessage>(&json.replace("\"buffer\"", "\"image\"")).is_err()
    );
    Ok(())
}

#[test]
fn resource_admission_is_atomic_idempotent_and_explicitly_budgeted() -> Result<(), IrError> {
    let mut registry = ResourceRegistry::new(ResourceLimits {
        budget_bytes: 4,
        ..ResourceLimits::default()
    })?;
    let first = ResourceFixture::request(&[1, 2, 3, 4])?;
    let second = ResourceFixture::request(&[4, 3, 2, 1])?;
    assert_eq!(
        registry.put(first.clone(), vec![1, 2, 3, 4])?,
        PutOutcome::Inserted
    );
    let before = registry.statistics();
    assert_eq!(
        registry.put(first.clone(), vec![1, 2, 3, 4])?,
        PutOutcome::AlreadyPresent
    );
    assert_eq!(registry.statistics(), before);
    assert!(matches!(
        registry.put(second.clone(), vec![4, 3, 2, 1]),
        Err(IrError::ResourceBudgetExceeded { .. })
    ));
    assert_eq!(registry.statistics(), before);
    assert!(matches!(
        registry.put(first.clone(), vec![1, 2, 3, 5]),
        Err(IrError::HashMismatch)
    ));
    assert_eq!(registry.resolve(&first.hash)?, &[1, 2, 3, 4]);
    registry.evict(&first.hash)?;
    assert_eq!(registry.statistics().used_bytes, 0);
    assert_eq!(
        registry.put(second, vec![4, 3, 2, 1])?,
        PutOutcome::Inserted
    );
    assert!(matches!(
        registry.evict(&first.hash),
        Err(IrError::MissingResource(_))
    ));
    Ok(())
}

#[test]
fn missing_references_and_failed_multi_resource_pins_do_not_mutate_state() -> Result<(), IrError> {
    let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
    let fixture = Fixture::new()?;
    assert!(matches!(
        registry.validate_references(&fixture.metadata),
        Err(IrError::MissingResource(_))
    ));
    let first = ResourceFixture::request(&[1, 2, 3, 4])?;
    registry.put(first.clone(), vec![1, 2, 3, 4])?;
    registry.validate_references(&fixture.metadata)?;
    let before = registry.statistics();
    assert!(
        registry
            .pin(&[first.hash.clone(), ResourceHash("0".repeat(64))])
            .is_err()
    );
    assert_eq!(registry.statistics(), before);
    let lease = registry.pin(std::slice::from_ref(&first.hash))?;
    assert!(matches!(
        registry.evict(&first.hash),
        Err(IrError::ResourceInUse(_))
    ));
    registry.release(&lease)?;
    registry.release(&lease)?;
    registry.evict(&first.hash)?;
    assert_eq!(registry.statistics().used_bytes, 0);
    Ok(())
}

#[test]
fn empty_leases_obey_limits_and_cannot_release_another_registry() -> Result<(), IrError> {
    let limits = ResourceLimits {
        max_leases: 1,
        ..ResourceLimits::default()
    };
    let mut first = ResourceRegistry::new(limits.clone())?;
    let mut second = ResourceRegistry::new(limits)?;
    let a = first.pin(&[])?;
    let b = second.pin(&[])?;
    assert!(matches!(first.pin(&[]), Err(IrError::LimitExceeded(_))));
    assert!(matches!(first.release(&b), Err(IrError::InvalidLease)));
    assert_eq!(first.statistics().active_leases, 1);
    assert_eq!(second.statistics().active_leases, 1);
    first.release(&a)?;
    first.release(&a)?;
    second.release(&b)?;
    assert_eq!(first.statistics().active_leases, 0);
    assert_eq!(second.statistics().active_leases, 0);
    Ok(())
}

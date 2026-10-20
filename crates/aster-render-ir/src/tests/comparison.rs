use super::Fixture;
use crate::{
    DecodeLimits, FplnCodec, IrError, OwnedFpln, PlanComparison, ResourceLimits, ResourceRegistry,
};

struct ComparisonFixture;
impl ComparisonFixture {
    fn plan(value: f32) -> Result<OwnedFpln, IrError> {
        let mut fixture = Fixture::new()?;
        fixture.metadata.resources.clear();
        fixture.blobs[0][8..12].copy_from_slice(&value.to_le_bytes());
        FplnCodec::decode(fixture.encode()?, &DecodeLimits::default())
    }

    fn scene_control(value: f32) -> Result<OwnedFpln, IrError> {
        let mut fixture = Fixture::new()?;
        fixture.metadata.resources.clear();
        fixture.metadata.contract_level = crate::ContractLevel::SceneBuffersSliceV1;
        fixture.metadata.blobs.truncate(1);
        fixture.metadata.blobs[0].byte_length = 592;
        fixture.metadata.blobs[0].element_count = 148;
        fixture.metadata.slices = vec![crate::PlanSlice::SceneBuffers(crate::SceneBuffersSlice {
            blob_index: 0,
            vertex_count: 0,
            motion_vectors: false,
            shadows_enabled: false,
            draws: Vec::new(),
            media_bindings: Vec::new(),
        })];
        fixture.blobs = vec![vec![0; 592]];
        fixture.blobs[0][44..48].copy_from_slice(&value.to_le_bytes());
        FplnCodec::decode(fixture.encode()?, &DecodeLimits::default())
    }
}

#[test]
fn numeric_comparison_obeys_absolute_relative_and_nonfinite_boundaries() -> Result<(), IrError> {
    let registry = ResourceRegistry::new(ResourceLimits::default())?;
    let comparator = PlanComparison::default();
    for (a, b, equal) in [
        (0.0, 0.0000009, true),
        (0.0, 0.000002, false),
        (1000.0, 1000.005, true),
        (1000.0, 1000.02, false),
        (-0.0, 0.0, true),
    ] {
        let report = comparator.compare(
            &ComparisonFixture::plan(a)?,
            &registry,
            &ComparisonFixture::plan(b)?,
            &registry,
            &DecodeLimits::default(),
        )?;
        assert_eq!(report.equal, equal, "{a}/{b}");
        if !equal {
            assert_eq!(
                report.first_difference.as_ref().map(|d| d.path.as_str()),
                Some("/blobs/0/byte/8")
            );
        }
    }
    assert!(ComparisonFixture::plan(f32::NAN).is_err());
    assert!(ComparisonFixture::plan(f32::INFINITY).is_err());
    Ok(())
}

#[test]
fn metadata_and_control_lanes_remain_exact_and_limits_cannot_weaken_parity() -> Result<(), IrError>
{
    let registry = ResourceRegistry::new(ResourceLimits::default())?;
    let mut a = Fixture::new()?;
    a.metadata.resources.clear();
    let left = FplnCodec::decode(a.encode()?, &DecodeLimits::default())?;
    let mut b = Fixture {
        metadata: a.metadata.clone(),
        blobs: a.blobs.clone(),
    };
    b.metadata.header.project_revision -= 1;
    let right = FplnCodec::decode(b.encode()?, &DecodeLimits::default())?;
    let result = PlanComparison::default().compare(
        &left,
        &registry,
        &right,
        &registry,
        &DecodeLimits::default(),
    )?;
    assert_eq!(
        result.first_difference.as_ref().map(|d| d.path.as_str()),
        Some("/header/project_revision")
    );
    let left = ComparisonFixture::scene_control(0.0)?;
    let right = ComparisonFixture::scene_control(0.0000001)?;
    let result = PlanComparison::default().compare(
        &left,
        &registry,
        &right,
        &registry,
        &DecodeLimits::default(),
    )?;
    assert_eq!(
        result.first_difference.as_ref().map(|d| d.kind.as_str()),
        Some("integer_or_bytes")
    );
    for comparator in [
        PlanComparison {
            relative: 0.1,
            ..Default::default()
        },
        PlanComparison {
            absolute: f64::NAN,
            ..Default::default()
        },
        PlanComparison {
            max_plans: 0,
            ..Default::default()
        },
    ] {
        assert!(
            comparator
                .compare(&left, &registry, &left, &registry, &DecodeLimits::default())
                .is_err()
        );
    }
    Ok(())
}

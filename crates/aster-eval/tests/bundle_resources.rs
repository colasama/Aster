use aster_eval::{
    BundleLimits, BundleResources, EffectContext, EffectExecutionPlan, FramePlanRequest, LutPlan,
};
use aster_render_ir::ContractLevel;
use std::{error::Error, fs, path::PathBuf};

#[test]
fn bundle_resource_admission_is_closed_and_atomic() -> Result<(), Box<dyn Error>> {
    assert!(
        BundleResources::new(BundleLimits {
            max_bundle_bytes: 1_073_741_824,
            ..Default::default()
        })
        .is_ok()
    );
    assert!(
        BundleResources::new(BundleLimits {
            max_bundle_bytes: 1_073_741_825,
            ..Default::default()
        })
        .is_err()
    );
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let project: aster_types::editor::Project = serde_json::from_slice(&fs::read(
        root.join("examples/projects/minimal-golden.aster.json"),
    )?)?;
    let composition = &project.compositions[0];
    let layer = &composition.layers[0];
    let request: FramePlanRequest = serde_json::from_str(
        r#"{"snapshotScope":"resource-admission","projectRevision":1,"compositionId":"22222222-2222-4222-8222-222222222222","time":0,"target":{"width":320,"height":180},"renderTarget":{"width":320,"height":180},"antiAliasing":"off","shadowsEnabled":false}"#,
    )?;
    let execution = EffectExecutionPlan::build(
        request.header(composition)?,
        layer,
        &layer.id,
        EffectContext::Isolated,
    )?;
    let lut = LutPlan::prepare(layer)?;
    let plan = execution
        .layer_program(&[], 0.0, 1.0, 1, lut.resource.request().hash.clone())?
        .ok_or("missing isolated program")?;

    let mut missing = BundleResources::new(BundleLimits::default())?;
    assert!(
        missing
            .add_plan(&plan, ContractLevel::LayerEffectsSliceV1)
            .is_err()
    );
    assert!(missing.finish().is_empty());

    let mut unused = BundleResources::new(BundleLimits::default())?;
    unused.add(lut.resource.clone())?;
    assert!(unused.finish().is_empty());

    let mut bounded = BundleResources::new(BundleLimits {
        max_bundle_resources: 1,
        ..Default::default()
    })?;
    bounded.add(lut.resource.clone())?;
    bounded.add(lut.resource.clone())?;
    assert!(
        bounded
            .add_plan(&plan, ContractLevel::LayerEffectsSliceV1)
            .is_err()
    );
    assert!(bounded.finish().is_empty());

    let mut bytes = BundleResources::new(BundleLimits {
        max_bundle_bytes: 63,
        ..Default::default()
    })?;
    assert!(bytes.add(lut.resource.clone()).is_err());
    assert!(bytes.finish().is_empty());

    let mut valid = BundleResources::new(BundleLimits::default())?;
    valid.add(lut.resource.clone())?;
    assert!(
        valid
            .add_plan(&plan, ContractLevel::SceneBuffersSliceV1)
            .is_err()
    );
    let hash = valid.add_plan(&plan, ContractLevel::LayerEffectsSliceV1)?;
    assert_eq!(
        valid.add_plan(&plan, ContractLevel::LayerEffectsSliceV1)?,
        hash
    );
    let resources = valid.finish();
    assert_eq!(resources.len(), 2);
    assert!(
        resources
            .windows(2)
            .all(|w| w[0].request().hash < w[1].request().hash)
    );
    assert!(
        resources
            .iter()
            .any(|r| r.request().hash == lut.resource.request().hash)
    );
    Ok(())
}

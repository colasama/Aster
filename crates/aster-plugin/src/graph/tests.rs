use super::*;

#[test]
fn validates_bloom_and_builds_concrete_compute_dispatches() {
    let validated = examples::bloom()
        .validate(GraphValidationContext::new(1920, 1080))
        .unwrap();

    assert_eq!(validated.execution_order, vec![0, 1, 2, 3]);
    assert_eq!(
        validated.compute_dispatches["blur_horizontal"],
        [120, 68, 1]
    );
    assert_eq!(validated.compute_dispatches["blur_vertical"], [120, 68, 1]);
    assert_eq!(validated.estimated_transient_bytes, 3 * 960 * 540 * 8);
    assert_eq!(validated.dependency_edges, 3);
}

#[test]
fn validates_multi_pass_blur_with_implicit_and_explicit_dependency_deduplication() {
    let validated = examples::multi_pass_blur()
        .validate(GraphValidationContext::new(3840, 2160))
        .unwrap();

    assert_eq!(validated.execution_order, vec![0, 1]);
    assert_eq!(validated.dependency_edges, 1);
    assert_eq!(validated.estimated_transient_bytes, 3840 * 2160 * 8);
}

#[test]
fn rejects_cycles_and_uninitialized_temporary_reads() {
    let mut cyclic = examples::multi_pass_blur();
    let GraphPass::Render { depends_on, .. } = &mut cyclic.passes[0] else {
        unreachable!();
    };
    depends_on.push("vertical".into());
    assert_eq!(
        cyclic.validate(GraphValidationContext::new(1280, 720)),
        Err(GraphValidationError::DependencyCycle)
    );

    let mut missing_writer = examples::multi_pass_blur();
    missing_writer.passes.remove(0);
    let GraphPass::Render { depends_on, .. } = &mut missing_writer.passes[0] else {
        unreachable!();
    };
    depends_on.clear();
    assert_eq!(
        missing_writer.validate(GraphValidationContext::new(1280, 720)),
        Err(GraphValidationError::UnwrittenTemporary(
            "horizontal".into()
        ))
    );
}

#[test]
fn rejects_resource_and_dispatch_quota_overruns_before_allocation() {
    let graph = examples::bloom();
    let mut context = GraphValidationContext::new(7680, 4320);
    context.quota.max_transient_bytes = 1_000_000;
    assert!(matches!(
        graph.validate(context),
        Err(GraphValidationError::QuotaExceeded {
            resource: "transient bytes",
            ..
        })
    ));

    for workgroups in [[65_536, 1, 1], [1, 1, 65_536]] {
        let mut graph = examples::bloom();
        let GraphPass::Compute { dispatch, .. } = &mut graph.passes[1] else {
            unreachable!();
        };
        *dispatch = ComputeDispatch::Fixed { workgroups };
        assert!(matches!(
            graph.validate(GraphValidationContext::new(1920, 1080)),
            Err(GraphValidationError::InvalidDispatchSize { .. })
        ));
    }
}

#[test]
fn rejects_path_traversal_usage_mismatch_and_read_write_aliases() {
    let mut traversal = examples::bloom();
    let GraphPass::Render { shader, .. } = &mut traversal.passes[0] else {
        unreachable!();
    };
    *shader = "../escape.wgsl".into();
    assert!(matches!(
        traversal.validate(GraphValidationContext::new(1920, 1080)),
        Err(GraphValidationError::InvalidShaderPath(_))
    ));

    let mut usage = examples::multi_pass_blur();
    usage.temporary_textures[0]
        .usage
        .remove(&TextureUsage::Sampled);
    assert!(matches!(
        usage.validate(GraphValidationContext::new(1920, 1080)),
        Err(GraphValidationError::MissingTextureUsage { .. })
    ));

    let mut alias = examples::bloom();
    let GraphPass::Compute {
        sampled_inputs,
        storage_outputs,
        ..
    } = &mut alias.passes[1]
    else {
        unreachable!();
    };
    storage_outputs[0] = sampled_inputs[0].clone();
    assert!(matches!(
        alias.validate(GraphValidationContext::new(1920, 1080)),
        Err(GraphValidationError::ReadWriteAlias { .. })
    ));
}

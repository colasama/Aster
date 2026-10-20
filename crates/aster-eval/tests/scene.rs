use aster_eval::{EvaluationLimits, ExpressionLimits, SceneLimits, SceneProject};
use aster_types::editor::{Field, Project};
use std::{error::Error, fs, path::PathBuf};

#[test]
fn native_scene_budgets_cycles_and_cloner_instances_are_bounded() -> Result<(), Box<dyn Error>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/projects/minimal-golden.aster.json");
    let mut project: Project = serde_json::from_slice(&fs::read(path)?)?;
    let limits = SceneLimits::default();
    let evaluation = EvaluationLimits::default();
    let expressions = ExpressionLimits::default();
    assert!(
        SceneProject::compile(
            project.clone(),
            &SceneLimits {
                max_project_layers: 0,
                ..limits.clone()
            },
            &evaluation,
            &expressions
        )
        .is_err()
    );
    let scene = SceneProject::compile(project.clone(), &limits, &evaluation, &expressions)?;
    assert!(scene.evaluate("absent-composition", 0.).is_err());
    assert!(
        scene
            .evaluate(&project.active_composition_id, f64::NAN)
            .is_err()
    );
    assert!(
        scene
            .world_transform(&project.active_composition_id, "absent-layer", 0.)
            .is_err()
    );
    let id = project.compositions[0].id.clone();
    project.compositions[0].layers.truncate(1);
    let layer = &mut project.compositions[0].layers[0];
    layer.kind = "precomposition".into();
    layer.source_composition_id = Field::Value(id.clone());
    layer.three_dimensional = false;
    layer.effects.clear();
    let cyclic = SceneProject::compile(project.clone(), &limits, &evaluation, &expressions)?;
    assert!(cyclic.evaluate(&id, 0.)?.is_empty());
    let limited = SceneProject::compile(
        project.clone(),
        &SceneLimits {
            max_composition_depth: 0,
            ..limits.clone()
        },
        &evaluation,
        &expressions,
    )?;
    assert!(limited.evaluate(&id, 0.).is_err());
    let layer = &mut project.compositions[0].layers[0];
    layer.kind = "shape".into();
    assert!(serde_json::from_str::<aster_types::editor::Cloner>("{}").is_err());
    layer.cloner = Field::Value(serde_json::from_str(
        r#"{"distribution":{"kind":"grid","count":[2,1,1],"spacing":[20,0,0]},"effectors":[]}"#,
    )?);
    let cloner = SceneProject::compile(project.clone(), &limits, &evaluation, &expressions)?;
    let instances = cloner.evaluate(&id, 0.)?;
    assert_eq!(instances.len(), 2);
    assert_ne!(instances[0].instance_id, instances[1].instance_id);
    assert_eq!(
        instances[0].resource_instance_id,
        instances[1].resource_instance_id
    );
    assert_eq!(instances[0].selection_id, instances[1].selection_id);
    assert!(
        SceneProject::compile(
            project,
            &SceneLimits {
                cloners: aster_eval::ClonerLimits {
                    max_cloner_instances: 1,
                    ..Default::default()
                },
                ..limits
            },
            &evaluation,
            &expressions
        )
        .is_err()
    );
    Ok(())
}

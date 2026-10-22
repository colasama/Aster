use aster_eval::{
    BundleLimits, EvaluationLimits, ExpressionLimits, FramePlanRequest, GeneratorCatalog,
    GeneratorDeviceLimits, GeneratorFrameSettings, PrecompositionSources, RootResourceBindings,
    SceneLimits, SceneProject, SurfacePreparation, SurfaceProgramInputs, SurfaceSource,
    SurfaceTarget, UnavailableGenerator, UnavailableGeneratorReason,
};
use aster_render_ir::{AntiAliasing, CompositionIdentity, Extent2d, PlanSlice};
use aster_types::editor::{Field, Generator, Project};
use std::{collections::BTreeMap, error::Error, fs, path::PathBuf};

struct Fixture;
impl Fixture {
    fn project() -> Result<Project, Box<dyn Error>> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/projects/minimal-golden.aster.json");
        let mut project: Project = serde_json::from_slice(&fs::read(path)?)?;
        let layer = &mut project.compositions[0].layers[0];
        layer.kind = "generator".into();
        layer.effects.clear();
        layer.generator = Field::Value(Generator {
            plugin_id: "com.example.unavailable".into(),
            node_type: "cloud".into(),
            api_version: 1.into(),
            parameters: BTreeMap::new(),
            extensions: BTreeMap::new(),
        });
        Ok(project)
    }

    fn unavailable(reason: UnavailableGeneratorReason) -> UnavailableGenerator {
        UnavailableGenerator {
            plugin_id: "com.example.unavailable".into(),
            node_type: "cloud".into(),
            reason,
        }
    }

    fn device() -> GeneratorDeviceLimits {
        GeneratorDeviceLimits {
            memory_budget_mb: 512.,
            storage_byte_limit: 64 * 1024 * 1024,
            dispatch_workgroup_limit: 65535,
        }
    }
}

#[test]
fn explicit_unavailable_generators_are_omitted_from_root_and_nested_commands()
-> Result<(), Box<dyn Error>> {
    let document = Fixture::project()?;
    let composition = &document.compositions[0];
    let request = FramePlanRequest {
        snapshot_scope: "availability-test".into(),
        project_revision: 0,
        composition_id: composition.id.clone(),
        time: 0.5,
        target: Extent2d {
            width: 320,
            height: 180,
        },
        render_target: Extent2d {
            width: 320,
            height: 180,
        },
        anti_aliasing: AntiAliasing::Off,
        shadows_enabled: false,
    };
    let header = request.header(composition)?;
    let project = SceneProject::compile(
        document.clone(),
        &SceneLimits::default(),
        &EvaluationLimits::default(),
        &ExpressionLimits::default(),
    )?;
    let layers = project.evaluate(&composition.id, request.time)?;
    let generator = layers
        .iter()
        .find(|layer| layer.layer_id == composition.layers[0].id)
        .ok_or("generator was not evaluated")?;
    let generator_id = CompositionIdentity::Unicode(generator.instance_id.clone());
    let settings = GeneratorFrameSettings {
        device: Fixture::device(),
        camera: None,
        audio: None,
    };
    let empty = GeneratorCatalog::compile(Vec::new(), Default::default(), BundleLimits::default())?;
    assert!(
        project
            .plan_generators(header.clone(), &layers, &empty, &settings)
            .is_err()
    );
    let sources = PrecompositionSources {
        operations: vec![SurfacePreparation::Scene {
            source: SurfaceSource {
                target: SurfaceTarget {
                    id: "nested-target".into(),
                    width: 320,
                    height: 180,
                    estimated_bytes: 320 * 180 * 12,
                    texture_count: 2,
                    has_effects: false,
                },
                composition_id: composition.id.clone(),
                time: request.time,
                layers: layers.clone(),
            },
        }],
        ..Default::default()
    };
    let inputs = SurfaceProgramInputs {
        bindings: RootResourceBindings::default(),
        text_bounds: BTreeMap::new(),
        generator_device: Fixture::device(),
        audio: None,
    };
    assert!(
        project
            .plan_surface_programs(header.clone(), &sources, &inputs, &empty)
            .is_err()
    );
    for reason in [
        UnavailableGeneratorReason::Missing,
        UnavailableGeneratorReason::Disabled,
        UnavailableGeneratorReason::SafeMode,
    ] {
        let catalog = empty
            .clone()
            .with_unavailable(vec![Fixture::unavailable(reason)])?;
        assert!(
            project
                .plan_generators(header.clone(), &layers, &catalog, &settings)?
                .is_empty()
        );
        let scene = project.plan_evaluated_scene(&request, &layers, &BTreeMap::new())?;
        let root = project.plan_evaluated_root(
            &request,
            &scene,
            &RootResourceBindings::default(),
            &layers,
            aster_eval::EffectContext::Root,
        )?;
        let Some(PlanSlice::RootSceneCommands(root_commands)) = root.metadata.slices.first() else {
            return Err("root commands missing".into());
        };
        assert!(!root_commands.draws.is_empty());
        assert!(
            root_commands
                .draws
                .iter()
                .all(|draw| draw.instance_id != generator_id)
        );
        let nested = project.plan_surface_programs(header.clone(), &sources, &inputs, &catalog)?;
        assert_eq!(nested.scenes.len(), 1);
        assert!(nested.scenes[0].generators.is_empty());
        let Some(PlanSlice::RootSceneCommands(commands)) =
            nested.scenes[0].commands.metadata.slices.first()
        else {
            return Err("nested commands missing".into());
        };
        assert!(!commands.draws.is_empty());
        assert!(
            commands
                .draws
                .iter()
                .all(|draw| draw.instance_id != generator_id)
        );
    }
    Ok(())
}

#[test]
fn unavailable_grants_cannot_hide_builtins_or_exceed_catalog_limits() -> Result<(), Box<dyn Error>>
{
    let empty = GeneratorCatalog::compile(Vec::new(), Default::default(), BundleLimits::default())?;
    let item = Fixture::unavailable(UnavailableGeneratorReason::Missing);
    assert!(
        empty
            .clone()
            .with_unavailable(vec![item.clone(), item.clone()])
            .is_err()
    );
    let mut reserved = item.clone();
    reserved.plugin_id = "org.aster.builtin.particles".into();
    assert!(empty.with_unavailable(vec![reserved]).is_err());
    let bounded = GeneratorCatalog::compile(
        Vec::new(),
        Default::default(),
        BundleLimits {
            max_bundle_resources: 1,
            ..Default::default()
        },
    )?;
    let mut second = item.clone();
    second.node_type = "another_node".into();
    assert!(bounded.with_unavailable(vec![item, second]).is_err());
    Ok(())
}

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use super::*;

pub(crate) struct PluginFixture;
impl PluginFixture {
    pub(crate) const EFFECT: &str = r#"
struct AsterEffectUniforms {
    resolution: vec2f,
    time: f32,
    parameter_count: u32,
    parameters: array<vec4f, 16>,
}

@group(0) @binding(0) var aster_source: texture_2d<f32>;
@group(0) @binding(1) var aster_sampler: sampler;
@group(0) @binding(2) var<uniform> aster: AsterEffectUniforms;

@fragment
fn aster_effect(@location(0) uv: vec2f) -> @location(0) vec4f {
    let source = textureSample(aster_source, aster_sampler, uv);
    return vec4f(source.rgb * aster.parameters[0].x, source.a);
}
"#;
}

#[test]
fn parses_wgsl_effect_manifest() -> Result<(), Box<dyn std::error::Error>> {
    let manifest = crate::PluginLimits::default().parse_manifest(
        r#"
                [plugin]
                id = "org.aster.tint"
                name = "Tint"
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"

                [[parameters]]
                type = "number"
                name = "amount"
                label = "Amount"
                default = 1.0
                min = 0.0
                max = 1.0
            "#,
    )?;
    assert_eq!(manifest.plugin.id, "org.aster.tint");
    assert_eq!(manifest.parameters.len(), 1);

    let reserved = crate::PluginLimits::default().parse_manifest(
        r#"
                [plugin]
                id = "org.aster.builtin.shadow"
                name = "Shadow"
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"
            "#,
    )?;
    assert!(matches!(
        PluginMetadata::validate_external_id(&reserved.plugin.id),
        Err(PluginError::ReservedId(id)) if id == "org.aster.builtin.shadow"
    ));

    let invalid_name = crate::PluginLimits::default()
        .parse_manifest(
            r#"
                [plugin]
                id = "org.example.empty-name"
                name = "  "
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"
            "#,
        )
        .err()
        .ok_or("expected rejection")?;
    assert!(matches!(invalid_name, PluginError::InvalidName(_)));

    let oversized = " ".repeat(PluginLimits::default().max_manifest_bytes as usize + 1);
    assert!(matches!(
        crate::PluginLimits::default().parse_manifest(&oversized),
        Err(PluginError::ManifestTooLarge(_))
    ));
    Ok(())
}

#[test]
fn validates_parameter_schema_before_exposing_it_to_the_host()
-> Result<(), Box<dyn std::error::Error>> {
    let invalid_color = crate::PluginLimits::default()
        .parse_manifest(
            r#"
                [plugin]
                id = "org.aster.invalid-color"
                name = "Invalid Color"
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"

                [[parameters]]
                type = "color"
                name = "tint"
                label = "Tint"
                default = [1.2, 0.5, 0.5, 1.0]
            "#,
        )
        .err()
        .ok_or("expected rejection")?;
    assert!(matches!(invalid_color, PluginError::InvalidParameter(name) if name == "tint"));

    let invalid_name = crate::PluginLimits::default()
        .parse_manifest(
            r#"
                [plugin]
                id = "org.aster.invalid-name"
                name = "Invalid Name"
                version = "1.0.0"
                api_version = 1
                shader = "effect.wgsl"

                [[parameters]]
                type = "texture"
                name = "source texture"
                label = "Source"
            "#,
        )
        .err()
        .ok_or("expected rejection")?;
    assert!(
        matches!(invalid_name, PluginError::InvalidParameter(name) if name == "source texture")
    );
    Ok(())
}

#[test]
fn discovers_valid_plugins_and_reports_isolated_failures() -> Result<(), Box<dyn std::error::Error>>
{
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let root = std::env::temp_dir().join(format!("aster-plugin-{nonce}"));
    let valid = root.join("valid");
    let invalid = root.join("invalid");
    fs::create_dir_all(&valid)?;
    fs::create_dir_all(&invalid)?;
    fs::write(
        valid.join("plugin.toml"),
        r#"
                capabilities = ["gpu_render"]

                [plugin]
                id = "org.aster.valid"
                name = "Valid"
                version = "1.2.3"
                api_version = 1
                shader = "effect.wgsl"
            "#,
    )?;
    fs::write(valid.join("effect.wgsl"), PluginFixture::EFFECT)?;
    fs::write(
        invalid.join("plugin.toml"),
        r#"
                [plugin]
                id = "org.aster.invalid"
                name = "Invalid"
                version = "latest"
                api_version = 1
                shader = "../escape.wgsl"
            "#,
    )?;

    let report = PluginRepository::at(&root).discover(|_| true)?;
    assert_eq!(report.plugins.len(), 1);
    assert_eq!(report.failures.len(), 1);
    assert!(report.failures[0].message.contains("version"));
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn discovery_isolates_duplicate_plugin_ids_before_sources_are_projected()
-> Result<(), Box<dyn std::error::Error>> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let root = std::env::temp_dir().join(format!("aster-plugin-duplicate-{nonce}"));
    for folder in ["first", "second"] {
        let directory = root.join(folder);
        fs::create_dir_all(&directory)?;
        fs::write(
            directory.join("plugin.toml"),
            r#"
                    capabilities = ["gpu_render"]

                    [plugin]
                    id = "org.example.duplicate"
                    name = "Duplicate"
                    version = "1.0.0"
                    api_version = 1
                    shader = "effect.wgsl"
                "#,
        )?;
        fs::write(directory.join("effect.wgsl"), PluginFixture::EFFECT)?;
    }

    let report = PluginRepository::at(&root).discover(|_| true)?;
    assert_eq!(report.plugins.len(), 1);
    assert_eq!(report.shader_sources.len(), 1);
    assert_eq!(report.failures.len(), 1);
    assert!(
        report.failures[0]
            .message
            .contains("installed more than once")
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn metadata_discovery_does_not_open_shader_payloads() -> Result<(), Box<dyn std::error::Error>> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let root = std::env::temp_dir().join(format!("aster-plugin-metadata-{nonce}"));
    let directory = root.join("metadata-only");
    fs::create_dir_all(&directory)?;
    fs::write(
        directory.join("plugin.toml"),
        r#"
                capabilities = ["gpu_render"]

                [plugin]
                id = "org.example.metadata"
                name = "Metadata only"
                version = "1.0.0"
                api_version = 1
                shader = "missing.wgsl"
            "#,
    )?;

    let metadata = PluginRepository::at(&root).discover(|_| false)?;
    assert_eq!(metadata.plugins.len(), 1);
    assert!(metadata.shader_sources.is_empty());
    assert!(metadata.failures.is_empty());

    let selected = BTreeSet::from(["org.example.metadata".to_owned()]);
    let runtime = PluginRepository::at(&root).discover(|id| selected.contains(id))?;
    assert!(runtime.plugins.is_empty());
    assert_eq!(runtime.failures.len(), 1);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn installs_only_declared_plugin_files_and_replaces_versions()
-> Result<(), Box<dyn std::error::Error>> {
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let base = std::env::temp_dir().join(format!("aster-plugin-install-{nonce}"));
    let source = base.join("source");
    let installed = base.join("installed");
    fs::create_dir_all(&source)?;
    fs::write(
        source.join("plugin.toml"),
        r#"
                [plugin]
                id = "org.aster.install"
                name = "Install Test"
                version = "1.0.0"
                api_version = 1
                shader = "shaders/effect.wgsl"
            "#,
    )?;
    fs::create_dir_all(source.join("shaders"))?;
    fs::write(source.join("shaders/effect.wgsl"), PluginFixture::EFFECT)?;
    fs::write(source.join("undeclared.dll"), "not copied")?;

    let manifest = PluginRepository::at(&installed).install(&source)?;
    let destination = installed.join("org.aster.install");
    assert_eq!(manifest.plugin.version, "1.0.0");
    assert!(destination.join("plugin.toml").is_file());
    assert!(destination.join("shaders/effect.wgsl").is_file());
    assert!(!destination.join("undeclared.dll").exists());

    let next_manifest = fs::read_to_string(source.join("plugin.toml"))?.replace("1.0.0", "1.1.0");
    fs::write(source.join("plugin.toml"), next_manifest)?;
    assert_eq!(
        PluginRepository::at(&installed)
            .install(&source)?
            .plugin
            .version,
        "1.1.0"
    );
    fs::remove_dir_all(base)?;
    Ok(())
}

#[test]
fn rejects_valid_wgsl_with_an_incompatible_effect_interface()
-> Result<(), Box<dyn std::error::Error>> {
    let error = EffectAbi::validate_source(
        "@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }",
    )
    .err()
    .ok_or("expected rejection")?;
    assert!(matches!(error, PluginError::ShaderAbi(_)));
    assert!(error.to_string().contains("aster_effect"));
    Ok(())
}

#[test]
fn bundled_effect_examples_implement_the_v1_abi() -> Result<(), Box<dyn std::error::Error>> {
    let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins");
    for name in ["tint", "chromatic-aberration", "crt"] {
        PluginLimits::default().load(examples.join(name).join("plugin.toml"), true)?;
    }
    Ok(())
}

#[test]
fn bundled_scene_generator_example_implements_the_v1_abi() -> Result<(), Box<dyn std::error::Error>>
{
    let example = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/plugins/point-cloud/plugin.toml");
    let manifest = PluginLimits::default().load(example, true)?.manifest;
    assert_eq!(manifest.plugin.kind, PluginKind::SceneGenerator);
    assert_eq!(
        manifest
            .scene_generator
            .ok_or("scene generator missing")?
            .node_type,
        "point_cloud"
    );
    Ok(())
}

#[test]
fn scene_generator_rejects_binary_incompatible_standard_buffers()
-> Result<(), Box<dyn std::error::Error>> {
    let directory =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugins/point-cloud");
    let manifest = crate::PluginLimits::default()
        .parse_manifest(&fs::read_to_string(directory.join("plugin.toml"))?)?;
    let sources = BTreeMap::from([
        (
            "compute.wgsl".into(),
            fs::read_to_string(directory.join("compute.wgsl"))?,
        ),
        (
            "render.wgsl".into(),
            fs::read_to_string(directory.join("render.wgsl"))?,
        ),
    ]);

    let mut bad_context = sources.clone();
    for source in bad_context.values_mut() {
        *source = source.replacen("resolution: vec2f", "resolution: vec4f", 1);
    }
    assert!(matches!(
        SceneGeneratorValidator::default().validate(&manifest, &bad_context),
        Err(PluginError::GeneratorShaderAbi(message)) if message.contains("AsterGeneratorContext")
    ));

    let mut bad_parameters = sources.clone();
    for source in bad_parameters.values_mut() {
        *source = source.replace("array<vec4f, 128>", "array<vec4f, 64>");
    }
    assert!(matches!(
        SceneGeneratorValidator::default().validate(&manifest, &bad_parameters),
        Err(PluginError::GeneratorShaderAbi(message)) if message.contains("AsterGeneratorParameters")
    ));

    let mut bad_draw = sources.clone();
    let compute = bad_draw
        .get_mut("compute.wgsl")
        .ok_or("fixture shader missing")?;
    *compute = compute
        .replace("instance_count: atomic<u32>", "emitted_count: atomic<u32>")
        .replace("aster_draw.instance_count", "aster_draw.emitted_count");
    assert!(matches!(
        SceneGeneratorValidator::default().validate(&manifest, &bad_draw),
        Err(PluginError::GeneratorShaderAbi(message)) if message.contains("AsterDrawIndirect")
    ));

    let mut bad_stride = manifest.clone();
    bad_stride
        .scene_generator
        .as_mut()
        .ok_or("fixture field missing")?
        .instance_stride = 32;
    assert!(matches!(
        SceneGeneratorValidator::default().validate(&bad_stride, &sources),
        Err(PluginError::GeneratorShaderAbi(message)) if message.contains("stride 16")
    ));

    let mut bad_vertex_input = sources.clone();
    let render = bad_vertex_input
        .get_mut("render.wgsl")
        .ok_or("fixture shader missing")?;
    *render = render.replace(
        "@builtin(vertex_index) vertex: u32",
        "@location(7) vertex: u32",
    );
    assert!(matches!(
        SceneGeneratorValidator::default().validate(&manifest, &bad_vertex_input),
        Err(PluginError::GeneratorShaderAbi(message)) if message.contains("vertex entries")
    ));

    let mut bad_beauty_output = sources.clone();
    let render = bad_beauty_output
        .get_mut("render.wgsl")
        .ok_or("fixture shader missing")?;
    *render = render
        .replace(
            "fn fragment_main(input: VertexOutput) -> @location(0) vec4f",
            "fn fragment_main(input: VertexOutput) -> @location(0) u32",
        )
        .replace(
            "return vec4f(aster_parameters.values[3].xyz * alpha, alpha);",
            "return 1u;",
        );
    assert!(matches!(
        SceneGeneratorValidator::default().validate(&manifest, &bad_beauty_output),
        Err(PluginError::GeneratorShaderAbi(message)) if message.contains("fragment entry")
    ));
    Ok(())
}

#[test]
fn scene_generator_parameter_roles_are_typed() -> Result<(), Box<dyn std::error::Error>> {
    let example = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/plugins/point-cloud/plugin.toml");
    let source = fs::read_to_string(example)?;
    let capacity_error = crate::PluginLimits::default()
        .parse_manifest(&source.replace(
            "capacity_parameter = \"count\"",
            "capacity_parameter = \"color\"",
        ))
        .err()
        .ok_or("expected rejection")?;
    assert!(matches!(
        capacity_error,
        PluginError::InvalidGeneratorParameterRole {
            parameter,
            expected: "number"
        } if parameter == "color"
    ));

    let render_source = source
        .replace(
            "instance_stride = 16",
            "instance_stride = 16\nrender_parameter = \"radius\"",
        )
        .replace(
            "id = \"points\"",
            "id = \"points\"\nselector_value = \"points\"",
        );
    let render_error = crate::PluginLimits::default()
        .parse_manifest(&render_source)
        .err()
        .ok_or("expected rejection")?;
    assert!(matches!(
        render_error,
        PluginError::InvalidGeneratorParameterRole {
            parameter,
            expected: "choice"
        } if parameter == "radius"
    ));
    Ok(())
}

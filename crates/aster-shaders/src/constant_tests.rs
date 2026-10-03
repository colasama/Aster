use std::collections::BTreeMap;

use crate::{
    EntryPoint, ProgramDefinition, ProgramFragment, ShaderCatalog, ShaderError, ShaderManifest,
    ShaderStage,
};

struct Fixture {
    manifest: ShaderManifest,
    sources: BTreeMap<String, String>,
}

impl Fixture {
    fn load(value: u32) -> Self {
        Self {
            manifest: ShaderManifest {
                schema_version: 1,
                constants: BTreeMap::from([("layout-limit".to_owned(), value)]),
                fragments: BTreeMap::from([
                    ("before".to_owned(), "before.wgsl".to_owned()),
                    ("after".to_owned(), "after.wgsl".to_owned()),
                ]),
                programs: BTreeMap::from([(
                    "helper".to_owned(),
                    ProgramDefinition {
                        fragments: vec![
                            ProgramFragment::Source("before".to_owned()),
                            ProgramFragment::Constant {
                                constant: "layout-limit".to_owned(),
                            },
                            ProgramFragment::Source("after".to_owned()),
                        ],
                        entry_points: Vec::new(),
                        overrides: BTreeMap::new(),
                    },
                )]),
            },
            sources: BTreeMap::from([
                (
                    "before.wgsl".to_owned(),
                    include_str!("../tests/fixtures/constant-before.wgsl").to_owned(),
                ),
                (
                    "after.wgsl".to_owned(),
                    include_str!("../tests/fixtures/constant-after.wgsl").to_owned(),
                ),
            ]),
        }
    }

    fn catalog(&self) -> Result<ShaderCatalog, ShaderError> {
        ShaderCatalog::from_json(
            &serde_json::to_string(&self.manifest)?,
            self.sources.clone(),
        )
    }
}

#[test]
fn integer_fragment_completes_real_wgsl_token_without_separators() -> Result<(), ShaderError> {
    let fixture = Fixture::load(7);
    let catalog = fixture.catalog()?;
    let helper = catalog.program("helper")?;
    assert_eq!(
        helper.source,
        include_str!("../tests/fixtures/constant-seven.wgsl")
    );
    assert!(helper.definition.entry_points.is_empty());
    assert!(helper.pipeline_constants(&BTreeMap::new())?.is_empty());
    assert!(
        helper
            .pipeline_constants(&BTreeMap::from([("layout-limit".to_owned(), 8.0)]))
            .is_err(),
        "Source constants cannot become pipeline overrides"
    );
    for value in [0, u32::MAX] {
        let catalog = Fixture::load(value).catalog()?;
        let source = &catalog.program("helper")?.source;
        assert!(source.contains(if value == 0 { "0u;" } else { "4294967295u;" }));
    }
    Ok(())
}

#[test]
fn helpers_still_require_actual_entry_points_to_equal_the_manifest() -> Result<(), ShaderError> {
    let mut fixture = Fixture::load(7);
    for program in fixture.manifest.programs.values_mut() {
        program.entry_points.push(EntryPoint {
            name: "layout_limit".to_owned(),
            stage: ShaderStage::Compute,
        });
    }
    assert!(matches!(fixture.catalog(), Err(ShaderError::Manifest(_))));
    let mut manifest: ShaderManifest =
        serde_json::from_str(include_str!("../../../shaders/manifest.json"))?;
    for program in manifest.programs.values_mut() {
        program.entry_points.clear();
    }
    assert!(matches!(
        ShaderCatalog::from_json(
            &serde_json::to_string(&manifest)?,
            ShaderCatalog::embedded_sources()
        ),
        Err(ShaderError::Manifest(_))
    ));
    Ok(())
}

#[test]
fn constants_require_declared_and_reachable_ids_not_equal_values() -> Result<(), ShaderError> {
    let mut fixture = Fixture::load(7);
    fixture.manifest.constants.clear();
    assert!(matches!(fixture.catalog(), Err(ShaderError::Manifest(_))));
    fixture.manifest.constants.insert("unused".to_owned(), 7);
    assert!(matches!(fixture.catalog(), Err(ShaderError::Manifest(_))));
    fixture
        .manifest
        .constants
        .insert("layout-limit".to_owned(), 7);
    assert!(matches!(fixture.catalog(), Err(ShaderError::Manifest(_))));
    fixture.manifest.constants.remove("unused");
    assert!(fixture.catalog().is_ok());
    fixture.manifest.constants.insert(String::new(), 7);
    for program in fixture.manifest.programs.values_mut() {
        program.fragments[1] = ProgramFragment::Constant {
            constant: String::new(),
        };
    }
    assert!(fixture.catalog().is_err());
    Ok(())
}

#[test]
fn constant_json_rejects_expressions_unknown_fields_and_non_u32_values() -> Result<(), ShaderError>
{
    let fixture = Fixture::load(7);
    let manifest = serde_json::to_string(&fixture.manifest)?;
    for replacement in [
        r#"{"constant":"layout-limit","fallback":7}"#,
        r#"{"constant":"layout-limit","fragment":"before"}"#,
        r#"{"expression":"layout-limit + 1"}"#,
        r#"{"constant":7}"#,
        r#"["layout-limit"]"#,
    ] {
        let invalid = manifest.replace(r#"{"constant":"layout-limit"}"#, replacement);
        assert_ne!(invalid, manifest);
        assert!(matches!(
            ShaderCatalog::from_json(&invalid, fixture.sources.clone()),
            Err(ShaderError::Json(_))
        ));
    }
    for value in ["-1", "0.5", "4294967296", "null", r#""7""#] {
        let invalid =
            manifest.replace(r#""layout-limit":7"#, &format!(r#""layout-limit":{value}"#));
        assert_ne!(invalid, manifest);
        assert!(matches!(
            ShaderCatalog::from_json(&invalid, fixture.sources.clone()),
            Err(ShaderError::Json(_))
        ));
    }
    let without_constants = manifest.replace(r#""constants":{"layout-limit":7},"#, "");
    assert_ne!(without_constants, manifest);
    let parsed: ShaderManifest = serde_json::from_str(&without_constants)?;
    assert!(parsed.constants.is_empty());
    assert!(ShaderCatalog::from_json(&without_constants, fixture.sources).is_err());
    Ok(())
}

use std::collections::BTreeMap;

use sha2::{Digest, Sha256};

use crate::{
    ProgramDefinition, ProgramFragment, ShaderCatalog, ShaderError, ShaderManifest, ShaderStage,
};

struct Fixture {
    manifest: ShaderManifest,
    sources: BTreeMap<String, String>,
}

impl Fixture {
    fn load() -> Result<Self, ShaderError> {
        Ok(Self {
            manifest: serde_json::from_str(include_str!("../../../shaders/manifest.json"))?,
            sources: ShaderCatalog::embedded_sources(),
        })
    }

    fn catalog(&self) -> Result<ShaderCatalog, ShaderError> {
        ShaderCatalog::from_json(
            &serde_json::to_string(&self.manifest)?,
            self.sources.clone(),
        )
    }

    fn replace_source(&mut self, before: &str, after: &str) -> Result<(), ShaderError> {
        let source = self
            .sources
            .get_mut("effects/anti-aliasing.wgsl")
            .ok_or_else(|| ShaderError::Manifest("Test shader is absent".to_owned()))?;
        assert!(
            source.contains(before),
            "The mutation must alter the real shader"
        );
        *source = source.replace(before, after);
        Ok(())
    }

    fn aa_definition(&mut self) -> Result<&mut ProgramDefinition, ShaderError> {
        self.manifest
            .programs
            .get_mut("output-anti-aliasing")
            .ok_or_else(|| ShaderError::Manifest("Test AA program is absent".to_owned()))
    }
}

#[test]
fn embedded_shader_preserves_reviewed_browser_bytes() -> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    let program = catalog.program("output-anti-aliasing")?;
    assert_eq!(program.source.len(), 2902);
    assert_eq!(
        format!("{:x}", Sha256::digest(program.source.as_bytes())),
        "115e982faeb62b663b6d704c1583c44720338a32d7e99154be0a138c549b14f4"
    );
    assert_eq!(program.definition.entry_points.len(), 3);
    assert_eq!(
        catalog.programs.len(),
        Fixture::load()?.manifest.programs.len()
    );
    assert!(matches!(
        catalog.program("absent"),
        Err(ShaderError::UnknownProgram(_))
    ));
    Ok(())
}

#[test]
fn pipeline_constants_preserve_defaults_and_check_u32_boundaries() -> Result<(), ShaderError> {
    let catalog = ShaderCatalog::embedded()?;
    let program = catalog.program("output-anti-aliasing")?;
    assert_eq!(
        program.pipeline_constants(&BTreeMap::new())?,
        BTreeMap::from([("scale".to_owned(), 1.0)])
    );
    for scale in [0.0, 2.0, 4.0, f64::from(u32::MAX)] {
        let values = BTreeMap::from([("scale".to_owned(), scale)]);
        assert_eq!(program.pipeline_constants(&values)?, values);
    }
    for scale in [
        -1.0,
        0.5,
        4_294_967_296.0,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ] {
        assert!(
            program
                .pipeline_constants(&BTreeMap::from([("scale".to_owned(), scale)]))
                .is_err()
        );
    }
    assert!(
        program
            .pipeline_constants(&BTreeMap::from([("scales".to_owned(), 2.0)]))
            .is_err()
    );
    Ok(())
}

#[test]
fn fragment_order_is_manifest_order_without_added_separators() -> Result<(), ShaderError> {
    let mut fixture = Fixture::load()?;
    let original = fixture
        .sources
        .remove("effects/anti-aliasing.wgsl")
        .ok_or_else(|| ShaderError::Manifest("Test source is absent".to_owned()))?;
    // Split inside a token: an implicit separator or sorted fragment order cannot validate.
    let split = original.find("binding").ok_or_else(|| {
        ShaderError::Manifest("The real AA shader has no binding declaration".to_owned())
    })? + 3;
    fixture
        .sources
        .insert("first.wgsl".to_owned(), original[..split].to_owned());
    fixture
        .sources
        .insert("second.wgsl".to_owned(), original[split..].to_owned());
    fixture.manifest.fragments.remove("output-anti-aliasing");
    fixture.manifest.fragments.extend([
        ("z-first".to_owned(), "first.wgsl".to_owned()),
        ("a-second".to_owned(), "second.wgsl".to_owned()),
    ]);
    fixture.aa_definition()?.fragments = vec![
        ProgramFragment::Source("z-first".to_owned()),
        ProgramFragment::Source("a-second".to_owned()),
    ];
    let catalog = fixture.catalog()?;
    assert_eq!(catalog.program("output-anti-aliasing")?.source, original);
    fixture.aa_definition()?.fragments.reverse();
    assert!(fixture.catalog().is_err());
    Ok(())
}

#[test]
fn manifest_rejects_unknown_versions_files_fragments_and_empty_programs() -> Result<(), ShaderError>
{
    let mut fixture = Fixture::load()?;
    fixture.manifest.schema_version = 2;
    assert!(fixture.catalog().is_err());
    fixture.manifest.schema_version = 1;
    fixture
        .sources
        .insert("extra.wgsl".to_owned(), String::new());
    assert!(fixture.catalog().is_err());
    fixture.sources.remove("extra.wgsl");
    for program in fixture.manifest.programs.values_mut() {
        program.fragments = vec![ProgramFragment::Source("absent".to_owned())];
    }
    assert!(fixture.catalog().is_err());
    for program in fixture.manifest.programs.values_mut() {
        program.fragments.clear();
    }
    assert!(fixture.catalog().is_err());
    let mut fixture = Fixture::load()?;
    fixture.sources.clear();
    assert!(fixture.catalog().is_err());
    fixture.manifest.programs.clear();
    assert!(fixture.catalog().is_err());
    Ok(())
}

#[test]
fn paths_remain_relative_shader_files() -> Result<(), ShaderError> {
    for path in [
        "../escape.wgsl",
        "/absolute.wgsl",
        "C:/file.wgsl",
        "x\\y.wgsl",
        "x/./y.wgsl",
        "x//y.wgsl",
        "source.txt",
    ] {
        let mut fixture = Fixture::load()?;
        let source = fixture
            .sources
            .values()
            .next()
            .cloned()
            .ok_or_else(|| ShaderError::Manifest("Test source is absent".to_owned()))?;
        fixture.sources = BTreeMap::from([(path.to_owned(), source)]);
        for value in fixture.manifest.fragments.values_mut() {
            *value = path.to_owned();
        }
        assert!(fixture.catalog().is_err(), "Accepted unsafe path {path}");
    }
    Ok(())
}

#[test]
fn unused_invalid_fragments_and_unreachable_aliases_cannot_skip_validation()
-> Result<(), ShaderError> {
    let mut fixture = Fixture::load()?;
    fixture
        .manifest
        .fragments
        .insert("unused".to_owned(), "unused.wgsl".to_owned());
    fixture.sources.insert(
        "unused.wgsl".to_owned(),
        "this is not valid WGSL".to_owned(),
    );
    let error = fixture
        .catalog()
        .expect_err("An unreferenced invalid fragment must be rejected");
    assert!(
        matches!(error, ShaderError::Manifest(message) if message.contains("unused") && message.contains("not used"))
    );
    fixture
        .manifest
        .fragments
        .insert("unused".to_owned(), "effects/anti-aliasing.wgsl".to_owned());
    fixture.sources.remove("unused.wgsl");
    assert!(
        fixture.catalog().is_err(),
        "A path alias does not make its fragment ID reachable"
    );
    let mut alias_program = fixture
        .manifest
        .programs
        .get("output-anti-aliasing")
        .cloned()
        .ok_or_else(|| ShaderError::Manifest("Test program is absent".to_owned()))?;
    alias_program.fragments = vec![ProgramFragment::Source("unused".to_owned())];
    fixture
        .manifest
        .programs
        .insert("alias-program".to_owned(), alias_program);
    assert!(
        fixture.catalog().is_ok(),
        "Referenced aliases may share the same embedded source"
    );
    Ok(())
}

#[test]
fn declared_entry_points_must_match_real_names_stages_and_multiplicity() -> Result<(), ShaderError>
{
    for mutation in 0..4 {
        let mut fixture = Fixture::load()?;
        let program = fixture.aa_definition()?;
        match mutation {
            0 => program.entry_points[0].stage = ShaderStage::Compute,
            1 => program.entry_points[0].name = "absent".to_owned(),
            2 => {
                program.entry_points.pop();
            }
            _ => program.entry_points.push(program.entry_points[0].clone()),
        }
        assert!(fixture.catalog().is_err());
    }
    Ok(())
}

#[test]
fn override_contract_rejects_drift_and_undeclared_numeric_ids() -> Result<(), ShaderError> {
    for (before, after) in [
        ("override scale: u32 = 1u;", "override scale: u32 = 2u;"),
        ("override scale: u32 = 1u;", "override scale: u32;"),
        (
            "override scale: u32 = 1u;",
            "@id(0) override scale: u32 = 1u;",
        ),
        (
            "override scale: u32 = 1u;",
            "override scale: u32 = 1u; override additional: u32 = 1u;",
        ),
    ] {
        let mut fixture = Fixture::load()?;
        fixture.replace_source(before, after)?;
        assert!(fixture.catalog().is_err());
    }
    for mutation in 0..3 {
        let mut fixture = Fixture::load()?;
        let program = fixture.aa_definition()?;
        match mutation {
            0 => program.overrides.clear(),
            1 => {
                for definition in program.overrides.values_mut() {
                    definition.default = 2.0;
                }
            }
            _ => {
                for definition in program.overrides.values_mut() {
                    definition.default = -1.0;
                }
            }
        }
        assert!(fixture.catalog().is_err());
    }
    Ok(())
}

#[test]
fn real_naga_parser_and_validator_reject_invalid_modules() -> Result<(), ShaderError> {
    let mut fixture = Fixture::load()?;
    fixture.replace_source(
        "override scale: u32 = 1u;",
        "override scale: unknown_type = 1u;",
    )?;
    assert!(matches!(fixture.catalog(), Err(ShaderError::Parse { .. })));
    let mut fixture = Fixture::load()?;
    fixture.replace_source(
        "@vertex fn vertex_main",
        "@compute @workgroup_size(1) fn vertex_main",
    )?;
    assert!(matches!(
        fixture.catalog(),
        Err(ShaderError::Validation { .. })
    ));
    Ok(())
}

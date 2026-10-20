use std::{collections::BTreeSet, fs, path::PathBuf};

use aster_types::editor::Project;
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::ProjectBundle;

#[test]
fn typed_editor_persistence_preserves_fields_and_rejects_future_versions_atomically()
-> Result<(), Box<dyn std::error::Error>> {
    let directory = std::env::temp_dir().join(format!("aster-editor-model-{}", Uuid::new_v4()));
    let mut source: Value = serde_json::from_str(include_str!(
        "../../../../examples/projects/minimal-golden.aster.json"
    ))?;
    source["schemaVersion"] = Value::from(10);
    source["vendorExtension"] = serde_json::from_str(r#"{"presentNull":null,"track":[1,2.5]}"#)?;
    let mut model: Project = serde_json::from_value(source.clone())?;
    let bundle = ProjectBundle::at(&directory);
    bundle.save_editor_model(&model)?;
    assert_eq!(bundle.load_editor_model()?, model);
    assert_eq!(bundle.load_editor()?, source);
    let before = fs::read(directory.join("project.json"))?;
    model.schema_version = 11;
    assert!(bundle.save_editor_model(&model).is_err());
    assert_eq!(fs::read(directory.join("project.json"))?, before);
    fs::remove_dir_all(directory)?;
    Ok(())
}

#[derive(Deserialize)]
struct Corpus {
    cases: Vec<CorpusCase>,
}

#[derive(Deserialize)]
struct CorpusCase {
    project: String,
}

#[test]
#[ignore = "requires generated parity projects and the owner performance project"]
fn typed_editor_model_roundtrips_every_corpus_project() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let corpus: Corpus = serde_json::from_slice(&fs::read(root.join("tests/parity/corpus.json"))?)?;
    assert!(!corpus.cases.is_empty());
    let mut projects = BTreeSet::new();
    for case in corpus.cases {
        let path = if case.project == "env:ASTER_PERF_PROJECT" {
            match std::env::var_os("ASTER_PERF_PROJECT") {
                Some(path) => PathBuf::from(path),
                None if cfg!(windows) => PathBuf::from(r"D:\code\SD04PV"),
                None => return Err("ASTER_PERF_PROJECT is required".into()),
            }
        } else {
            root.join(case.project)
        };
        projects.insert(if path.is_dir() {
            path.join("project.json")
        } else {
            path
        });
    }
    let mut versions = BTreeSet::new();
    for path in projects {
        let bytes = fs::read(&path)?;
        let source: Value = serde_json::from_slice(&bytes)?;
        let model: Project = serde_json::from_slice(&bytes)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        ProjectBundle::validate_editor(&source, true)?;
        assert!(model.composition(&model.active_composition_id).is_some());
        versions.insert(model.schema_version);
        assert!(
            serde_json::to_value(model)? == source,
            "Native document round-trip changed {}",
            path.display()
        );
    }
    assert!(versions.contains(&1));
    assert!(versions.contains(&10));
    Ok(())
}

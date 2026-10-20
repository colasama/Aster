use super::{Animatable, Field, Project};
use serde_json::Value;

#[test]
fn editor_model_preserves_legacy_document_without_normalizing_it() -> Result<(), serde_json::Error>
{
    let source: Value = serde_json::from_str(include_str!(
        "../../../../examples/projects/minimal-golden.aster.json"
    ))?;
    let project: Project = serde_json::from_value(source.clone())?;
    assert_eq!(project.schema_version, 1);
    assert!(
        project
            .composition(&project.active_composition_id)
            .is_some()
    );
    assert_eq!(serde_json::to_value(project)?, source);
    Ok(())
}

#[test]
fn editor_model_preserves_optional_presence_extensions_and_numeric_forms()
-> Result<(), serde_json::Error> {
    let mut source: Value = serde_json::from_str(include_str!(
        "../../../../examples/projects/minimal-golden.aster.json"
    ))?;
    source["schemaVersion"] = Value::from(10);
    source["fonts"] = Value::Null;
    source["vendor"] =
        serde_json::from_str(r#"{"nested":[null,1.0,9007199254740991,"\uD83C\uDF0C"]}"#)?;
    source["activeCompositionId"] = Value::from("composition-with-non-uuid-id");
    source["compositions"][0]["id"] = source["activeCompositionId"].clone();
    source["compositions"][0]["width"] = serde_json::from_str("320.0")?;
    source["compositions"][0]["layers"][0]["parentId"] = Value::Null;
    source["compositions"][0]["layers"][0]["transform"]["opacity"]["vendor"] = Value::from(true);
    let project: Project = serde_json::from_value(source.clone())?;
    assert_eq!(project.schema_version, 10);
    assert!(
        project
            .composition("composition-with-non-uuid-id")
            .is_some()
    );
    let serialized = serde_json::to_value(project)?;
    assert_eq!(serialized, source);
    assert!(serialized.get("sources").is_none());
    assert_eq!(serialized["fonts"], Value::Null);
    Ok(())
}

#[test]
fn editor_animation_preserves_tangents_and_rejects_unknown_storage_modes()
-> Result<(), serde_json::Error> {
    let source: Value = serde_json::from_str(
        r#"{"mode":"animated","keyframes":[{"id":"k","time":2.5,"value":-0.0,"interpolation":"bezier","easing":[0.42,0,0.58,1],"spatialIn":null,"spatialOut":4.25}],"vendor":7}"#,
    )?;
    let animation: Animatable = serde_json::from_value(source.clone())?;
    assert_eq!(serde_json::to_value(animation)?, source);
    assert!(serde_json::from_str::<Animatable>(r#"{"mode":"unknown","value":1}"#).is_err());
    assert!(serde_json::from_str::<Animatable>(r#"{"mode":"static","value":"bad"}"#).is_err());
    Ok(())
}

#[test]
fn editor_payloads_preserve_presence_and_reject_wrong_field_shapes() -> Result<(), serde_json::Error>
{
    let mut source: Value = serde_json::from_str(include_str!(
        "../../../../examples/projects/minimal-golden.aster.json"
    ))?;
    source["schemaVersion"] = Value::from(10);
    source["fonts"] = serde_json::from_str(
        r#"[{"id":"face","name":"Variable","family":"Example","weight":500,"weightRange":[100,900],"dataUrl":"data:font/ttf;base64,AAAA","extension":null}]"#,
    )?;
    source["compositions"][0]["layers"][0]["parentId"] = Value::Null;
    source["compositions"][0]["layers"][0]["generator"] = serde_json::from_str(
        r#"{"pluginId":"example","nodeType":"particles","apiVersion":1,"parameters":{"count":4,"enabled":true,"label":"🌌","vector":[1.0,2,3]},"extension":[null]}"#,
    )?;
    let model: Project = serde_json::from_value(source.clone())?;
    assert!(matches!(model.sources, Field::Absent));
    assert!(matches!(
        model.compositions[0].layers[0].parent_id,
        Field::Null
    ));
    assert_eq!(model.fonts.value().map(Vec::len), Some(1));
    assert_eq!(serde_json::to_value(model)?, source);
    let mut invalid = source.clone();
    invalid["fonts"][0]["weightRange"] = serde_json::from_str("[100,500,900]")?;
    assert!(serde_json::from_value::<Project>(invalid).is_err());
    source["compositions"][0]["layers"][0]["generator"]["parameters"]["count"] =
        serde_json::from_str(r#"{"not":"a parameter scalar"}"#)?;
    assert!(serde_json::from_value::<Project>(source).is_err());
    Ok(())
}

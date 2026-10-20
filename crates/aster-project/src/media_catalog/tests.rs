use super::*;

struct Fixture;
impl Fixture {
    fn document() -> Result<serde_json::Value, serde_json::Error> {
        serde_json::from_str(
            r#"{
          "sources":[{"id":"source","name":"Frames","kind":"imageSequence","mimeType":"image/png","contentIdentity":"sequence-identity","interpretation":{"alpha":"straight","colorSpace":"srgb"},"width":2,"height":1,"pattern":"f[##].png","startFrame":1,"endFrame":3}],
          "mediaImports":{"version":1,"entries":[{"sourceId":"source","kind":"imageSequence","contentIdentity":"sequence-identity","payloadId":"payload"}],"payloads":[{"id":"payload","kind":"imageSequence","contentIdentity":"sequence-identity","pattern":"f[##].png","prefix":"f","extension":".png","padding":2,"startFrame":1,"endFrame":3,"missingFrames":[2],"frameRate":{"numerator":1,"denominator":1},"missingFramePolicy":"holdPrevious","loop":false,"frames":[
            {"frame":1,"name":"f01.png","size":16,"lastModified":0,"type":"image/png","storage":{"kind":"inline","byteIdentity":"fnv64:5ec517ef189ba6b3:16","data":"aWRlbnRpdHktZml4dHVyZQ=="}},
            {"frame":3,"name":"f03.png","size":16,"lastModified":0,"type":"image/png","storage":{"kind":"inline","byteIdentity":"fnv64:5ec517ef189ba6b3:16","data":"aWRlbnRpdHktZml4dHVyZQ=="}}
          ]}]}}
        "#,
        )
    }
}

#[test]
fn sequence_selection_handles_holes_loops_boundaries_and_nearest_ties() -> Result<(), ProjectError>
{
    let catalog = ProjectMediaCatalog::from_slice(
        &serde_json::to_vec(&Fixture::document()?)?,
        &ProjectMediaCatalogLimits::default(),
    )?;
    let binding = catalog.bind("source")?;
    let Some(ProjectMediaPayload::ImageSequence(sequence)) = binding.payload.as_deref() else {
        return Err(ProjectError::InvalidMedia("test sequence absent"));
    };
    for (time, requested, actual) in [
        (-1., 1, 1),
        (0., 1, 1),
        (0.999_999_999_9, 2, 1),
        (1., 2, 1),
        (2., 3, 3),
        (100., 3, 3),
    ] {
        let sample = sequence.select(time)?;
        assert_eq!(
            (sample.requested_frame, sample.actual_frame, sample.missing),
            (requested, actual, requested != actual)
        );
    }
    let mut selected = sequence.clone();
    selected.missing_frame_policy = MissingSequenceFrame::Nearest;
    assert_eq!(selected.select(1.)?.actual_frame, 1);
    selected.looping = true;
    assert_eq!(selected.select(3.)?.actual_frame, 1);
    selected.missing_frame_policy = MissingSequenceFrame::Error;
    assert!(selected.select(4.).is_err());
    assert!(selected.select(f64::NAN).is_err());
    Ok(())
}

#[test]
fn catalog_rejects_mismatched_bindings_and_unbounded_or_inconsistent_sequences()
-> Result<(), ProjectError> {
    let valid = Fixture::document()?;
    let mut cases = Vec::new();
    for (pointer, value) in [
        (
            "/mediaImports/entries/0/contentIdentity",
            serde_json::Value::String("wrong".into()),
        ),
        (
            "/mediaImports/entries/0/sourceId",
            serde_json::Value::String("absent".into()),
        ),
        (
            "/mediaImports/entries/0/payloadId",
            serde_json::Value::String("absent".into()),
        ),
        (
            "/mediaImports/payloads/0/frames/1/frame",
            serde_json::Value::from(1),
        ),
        (
            "/mediaImports/payloads/0/frames/1/name",
            serde_json::Value::String("other03.png".into()),
        ),
        (
            "/mediaImports/payloads/0/endFrame",
            serde_json::Value::from(1_000_000_000),
        ),
        (
            "/mediaImports/payloads/0/frameRate/numerator",
            serde_json::Value::from(0),
        ),
    ] {
        let mut document = valid.clone();
        *document
            .pointer_mut(pointer)
            .ok_or(ProjectError::InvalidMedia("test field absent"))? = value;
        cases.push(document);
    }
    for document in cases {
        assert!(
            ProjectMediaCatalog::from_slice(
                &serde_json::to_vec(&document)?,
                &ProjectMediaCatalogLimits::default()
            )
            .is_err()
        );
    }
    assert!(
        ProjectMediaCatalog::from_slice(
            &serde_json::to_vec(&valid)?,
            &ProjectMediaCatalogLimits {
                media_sequence_frames: 1,
                ..Default::default()
            }
        )
        .is_err()
    );
    Ok(())
}

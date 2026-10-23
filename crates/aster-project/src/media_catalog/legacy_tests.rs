use super::*;

struct LegacyFixture;
impl LegacyFixture {
    fn document() -> Result<serde_json::Value, serde_json::Error> {
        serde_json::from_str(
            r#"{
          "sources":[{"id":"image","name":"legacy.png","kind":"still","mimeType":"image/png","contentIdentity":"fnv64:7b1ed30385af752f:43","width":2,"height":1,"interpretation":{"alpha":"straight","colorSpace":"srgb"}}],
          "mediaImports":{"version":1,"entries":[{"sourceId":"image","kind":"still","contentIdentity":"fnv64:7b1ed30385af752f:43","payloadId":"pixels"}],
          "payloads":[{"id":"pixels","kind":"still","contentIdentity":"fnv64:7b1ed30385af752f:43","mimeType":"image/png","storage":{"kind":"inline","byteIdentity":"fnv64:56cf37abc00005af:3","data":"AQID"},"legacyLocator":{"kind":"inline","prefix":"data:image/png;base64,"}}]}}
        "#,
        )
    }
    fn read(
        document: &serde_json::Value,
        frame: Option<i64>,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        let catalog = ProjectMediaCatalog::from_slice(
            &serde_json::to_vec(document)?,
            &ProjectMediaCatalogLimits::default(),
        )?;
        let binding = catalog.bind("image")?;
        let mut reader =
            MediaSourceReader::new(&std::env::temp_dir(), crate::MediaSourceLimits::default())?;
        let retained = binding.read(&mut reader, frame, 1024)?;
        let inspected = binding.inspect(&mut reader, frame, 1024)?;
        assert_eq!(retained.bytes, inspected.bytes);
        assert_eq!(retained.sha256, inspected.sha256);
        assert_eq!(retained.byte_length, inspected.byte_length);
        Ok(inspected)
    }
}

#[test]
fn legacy_locator_identity_and_frozen_bytes_are_independently_authenticated()
-> Result<(), Box<dyn std::error::Error>> {
    let document = LegacyFixture::document()?;
    assert_eq!(LegacyFixture::read(&document, None)?.bytes, vec![1, 2, 3]);
    assert!(LegacyFixture::read(&document, Some(0)).is_err());
    for (pointer, value) in [
        ("/sources/0/width", serde_json::Value::from(3)),
        (
            "/mediaImports/payloads/0/legacyLocator/prefix",
            serde_json::Value::from("data:image/jpeg;base64,"),
        ),
        (
            "/mediaImports/payloads/0/storage/data",
            serde_json::Value::from("AwIB"),
        ),
        (
            "/mediaImports/payloads/0/storage/byteIdentity",
            serde_json::Value::from("fnv64:0000000000000000:3"),
        ),
        (
            "/mediaImports/payloads/0/legacyLocator",
            serde_json::Value::Null,
        ),
    ] {
        let mut changed = document.clone();
        *changed.pointer_mut(pointer).ok_or("fixture field absent")? = value;
        assert!(LegacyFixture::read(&changed, None).is_err(), "{pointer}");
    }
    Ok(())
}

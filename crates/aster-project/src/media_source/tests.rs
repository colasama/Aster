use super::*;

struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Result<Self, ProjectError> {
        let root =
            std::env::temp_dir().join(format!("aster-project-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root)?;
        std::fs::write(root.join("media.bin"), b"identity-fixture")?;
        Ok(Self { root })
    }

    fn storage() -> ProjectMediaStorage {
        ProjectMediaStorage::Relative {
            relative_path: "media.bin".into(),
            byte_identity: "fnv64:5ec517ef189ba6b3:16".into(),
            resolved_path: Some("untrusted-path-is-ignored".into()),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn inline_and_relative_payloads_share_authenticated_bytes_without_materialization()
-> Result<(), ProjectError> {
    let fixture = Fixture::new()?;
    let mut reader = MediaSourceReader::new(&fixture.root, MediaSourceLimits::default())?;
    let file = reader.read(&Fixture::storage(), None, 16)?;
    let inline = ProjectMediaStorage::Inline {
        byte_identity: file.byte_identity.clone(),
        data: base64::engine::general_purpose::STANDARD.encode(&file.bytes),
    };
    let bytes = reader.read(&inline, Some(&format!("sha256:{}", file.sha256)), 16)?;
    assert_eq!(bytes.bytes, file.bytes);
    assert!(bytes.path.is_none());
    assert_eq!(reader.total_bytes, 16);
    assert_eq!(std::fs::read_dir(&fixture.root)?.count(), 1);
    let fallback = reader.read_relative_source("media.bin", &file.byte_identity, 16)?;
    assert_eq!(fallback.bytes, file.bytes);
    Ok(())
}

#[test]
fn corrupt_or_oversized_media_never_enters_job_budget() -> Result<(), ProjectError> {
    let fixture = Fixture::new()?;
    let mut reader = MediaSourceReader::new(
        &fixture.root,
        MediaSourceLimits {
            project_media_total_bytes: 16,
            project_media_files: 2,
            ..Default::default()
        },
    )?;
    assert!(reader.read(&Fixture::storage(), None, 15).is_err());
    assert!(reader.read(&Fixture::storage(), Some("wrong"), 16).is_err());
    let wrong = ProjectMediaStorage::Inline {
        byte_identity: "fnv64:5ec517ef189ba6b3:16".into(),
        data: "AA==".into(),
    };
    assert!(reader.read(&wrong, None, 16).is_err());
    assert_eq!((reader.files, reader.total_bytes), (0, 0));
    reader.read(&Fixture::storage(), None, 16)?;
    std::fs::write(fixture.root.join("media.bin"), b"changed contents")?;
    assert!(reader.read(&Fixture::storage(), None, 16).is_err());
    let identity = format!("sha256:{:x}", Sha256::digest(b"changed contents"));
    assert!(
        reader
            .read_relative_source("media.bin", &identity, 16)
            .is_err()
    );
    assert_eq!((reader.files, reader.total_bytes), (1, 16));
    std::fs::write(fixture.root.join("media.bin"), b"identity-fixture")?;
    reader.read(&Fixture::storage(), None, 16)?;
    assert!(reader.read(&Fixture::storage(), None, 16).is_err());
    Ok(())
}

#[test]
fn traversal_and_external_storage_cannot_grant_paths() -> Result<(), ProjectError> {
    let fixture = Fixture::new()?;
    let mut reader = MediaSourceReader::new(&fixture.root, MediaSourceLimits::default())?;
    for relative in [
        "../media.bin",
        "/media.bin",
        "a//b",
        "./media.bin",
        "a\\b",
        "C:/media.bin",
        "media.bin:stream",
    ] {
        assert!(reader.read_relative_source(relative, "wrong", 100).is_err());
    }
    let external = ProjectMediaStorage::External {
        external_path: fixture
            .root
            .join("media.bin")
            .to_string_lossy()
            .into_owned(),
        byte_identity: None,
    };
    assert!(reader.read(&external, None, 100).is_err());
    let wrong: Result<ProjectMediaStorage, _> = serde_json::from_str(
        r#"{"kind":"relative","relativePath":"media.bin","byteIdentity":"fnv64:5ec517ef189ba6b3:16","runtimeUrl":"file:///other"}"#,
    );
    assert!(wrong.is_err());
    assert_eq!((reader.files, reader.total_bytes), (0, 0));
    Ok(())
}

#[test]
fn inline_budget_is_aggregate_and_rejection_preserves_admitted_state() -> Result<(), ProjectError> {
    let fixture = Fixture::new()?;
    let mut reader = MediaSourceReader::new(
        &fixture.root,
        MediaSourceLimits {
            project_media_inline_bytes: 16,
            ..Default::default()
        },
    )?;
    let storage = ProjectMediaStorage::Inline {
        byte_identity: "fnv64:5ec517ef189ba6b3:16".into(),
        data: base64::engine::general_purpose::STANDARD.encode(b"identity-fixture"),
    };
    reader.read(&storage, None, 16)?;
    assert!(reader.read(&storage, None, 16).is_err());
    assert_eq!(
        (reader.files, reader.inline_bytes, reader.total_bytes),
        (1, 16, 16)
    );
    Ok(())
}

#[test]
fn file_inspection_streams_authenticated_metadata_and_preserves_admission_limits()
-> Result<(), ProjectError> {
    use std::io::{Seek, SeekFrom, Write};
    let fixture = Fixture::new()?;
    let bytes: Vec<u8> = (0..(65536 * 5 + 13)).map(|n| (n % 251) as u8).collect();
    std::fs::write(fixture.root.join("media.bin"), &bytes)?;
    let identity = MediaSourceReader::authenticate(bytes.clone(), None, None, None)?;
    let storage = ProjectMediaStorage::Relative {
        relative_path: "media.bin".into(),
        byte_identity: identity.byte_identity.clone(),
        resolved_path: Some("untrusted-path-is-ignored".into()),
    };
    let mut reader = MediaSourceReader::new(
        &fixture.root,
        MediaSourceLimits {
            project_media_total_bytes: bytes.len() as u64,
            ..Default::default()
        },
    )?;
    let inspected = reader.inspect(
        &storage,
        Some(&format!("sha256:{}", identity.sha256)),
        bytes.len() as u64,
    )?;
    assert!(inspected.bytes.is_empty());
    assert_eq!(inspected.byte_length, bytes.len() as u64);
    assert_eq!(inspected.sha256, identity.sha256);
    assert_eq!(inspected.byte_identity, identity.byte_identity);
    assert_eq!(
        inspected.path,
        Some(fixture.root.join("media.bin").canonicalize()?)
    );
    let retained = reader.read(&storage, None, bytes.len() as u64)?;
    assert_eq!(retained.bytes, bytes);
    assert_eq!(retained.byte_length, inspected.byte_length);
    assert_eq!((reader.files, reader.total_bytes), (2, bytes.len() as u64));
    assert!(
        reader
            .inspect(&storage, None, bytes.len() as u64 - 1)
            .is_err()
    );
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .open(fixture.root.join("media.bin"))?;
    file.seek(SeekFrom::Start(65537))?;
    file.write_all(&[255])?;
    drop(file);
    assert!(reader.inspect(&storage, None, bytes.len() as u64).is_err());
    let changed = std::fs::read(fixture.root.join("media.bin"))?;
    let changed_identity = MediaSourceReader::authenticate(changed, None, None, None)?;
    assert!(
        reader
            .read_relative_retained(
                "media.bin",
                &changed_identity.byte_identity,
                bytes.len() as u64,
                false
            )
            .is_err()
    );
    for relative in ["../media.bin", "C:/media.bin", "media.bin:stream"] {
        assert!(
            reader
                .read_relative_retained(
                    relative,
                    &identity.byte_identity,
                    bytes.len() as u64,
                    false
                )
                .is_err()
        );
    }
    assert_eq!((reader.files, reader.total_bytes), (2, bytes.len() as u64));
    Ok(())
}

#[test]
fn inline_inspection_retains_authenticated_bytes_and_charges_inline_budget()
-> Result<(), ProjectError> {
    let fixture = Fixture::new()?;
    let mut reader = MediaSourceReader::new(
        &fixture.root,
        MediaSourceLimits {
            project_media_inline_bytes: 16,
            ..Default::default()
        },
    )?;
    let storage = ProjectMediaStorage::Inline {
        byte_identity: "fnv64:5ec517ef189ba6b3:16".into(),
        data: base64::engine::general_purpose::STANDARD.encode(b"identity-fixture"),
    };
    let snapshot = reader.inspect(&storage, None, 16)?;
    assert_eq!(snapshot.bytes, b"identity-fixture");
    assert_eq!(snapshot.byte_length, 16);
    assert!(snapshot.path.is_none());
    assert!(reader.inspect(&storage, None, 16).is_err());
    assert_eq!(
        (reader.files, reader.total_bytes, reader.inline_bytes),
        (1, 16, 16)
    );
    Ok(())
}

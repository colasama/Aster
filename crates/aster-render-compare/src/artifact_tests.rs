use std::{fs, io, path::PathBuf, time::Duration};

use serde::{Serialize, Serializer, ser::Error};
use uuid::Uuid;

use super::{ArtifactOptions, ArtifactRenameOptions, ArtifactTransaction, ArtifactWriter};
use crate::{
    error::CompareError,
    image::{ImageLimits, RgbaImage},
    png::PngCodec,
};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn create() -> Result<Self, CompareError> {
        let path = std::env::temp_dir().join(format!("aster-compare-test-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self(path))
    }

    fn staged(&self) -> Result<ArtifactTransaction, CompareError> {
        let transaction = ArtifactTransaction::begin(&self.0.join("output"))?;
        for name in ["heatmap.png", "contact-sheet.png", "report.json"] {
            transaction.write(name, name.as_bytes())?;
        }
        Ok(transaction)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Serialize)]
struct Report {
    accepted: bool,
}

struct InvalidReport;

impl Serialize for InvalidReport {
    fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        Err(S::Error::custom("Intentional report serialization failure"))
    }
}

impl ArtifactOptions {
    fn fixture() -> Self {
        Self {
            heatmap_gain: 2,
            checker_size: 1,
            checker_dark: 32,
            checker_light: 200,
            max_output_pixels: 10,
            rename: ArtifactRenameOptions {
                max_attempts: 5,
                base_delay_ms: 20,
            },
        }
    }
}

#[test]
fn comparison_images_preserve_source_and_use_premultiplied_preview_math() -> Result<(), CompareError>
{
    let directory = TestDirectory::create()?;
    let reference = RgbaImage::new(1, 1, vec![50, 25, 0, 128])?;
    let candidate = RgbaImage::new(1, 1, vec![51, 25, 0, 128])?;
    let paths = ArtifactWriter::publish(
        &directory.0.join("output"),
        &reference,
        &candidate,
        &Report { accepted: false },
        &ArtifactOptions::fixture(),
    )?;
    let limits = ImageLimits {
        max_pixels: 10,
        max_file_bytes: 10_000,
    };
    let heatmap = PngCodec::decode(&fs::read(paths.heatmap)?, &limits)?;
    assert_eq!(heatmap.pixels, [2, 2, 2, 255]);
    let sheet = PngCodec::decode(&fs::read(paths.contact_sheet)?, &limits)?;
    assert_eq!((sheet.width, sheet.height), (2, 2));
    assert_eq!(
        sheet.pixels,
        [
            66, 41, 16, 255, 67, 41, 16, 255, 128, 128, 128, 255, 128, 128, 128, 255
        ]
    );
    assert_eq!(reference.pixels, [50, 25, 0, 128]);
    assert_eq!(candidate.pixels, [51, 25, 0, 128]);
    assert_eq!(
        fs::read_to_string(paths.report)?,
        "{\n  \"accepted\": false\n}"
    );
    assert_eq!(fs::read_dir(&directory.0)?.count(), 1);
    Ok(())
}

#[test]
fn hidden_rgb_errors_are_visible_in_the_opaque_heatmap() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let reference = RgbaImage::new(1, 1, vec![0, 0, 0, 0])?;
    let candidate = RgbaImage::new(1, 1, vec![30, 0, 0, 0])?;
    let paths = ArtifactWriter::publish(
        &directory.0.join("output"),
        &reference,
        &candidate,
        &Report { accepted: false },
        &ArtifactOptions::fixture(),
    )?;
    let heatmap = PngCodec::decode(
        &fs::read(paths.heatmap)?,
        &ImageLimits {
            max_pixels: 10,
            max_file_bytes: 10_000,
        },
    )?;
    assert_eq!(heatmap.pixels, [60, 60, 60, 255]);
    Ok(())
}

#[test]
fn failed_serialization_cleans_owned_staging_and_never_publishes() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let image = RgbaImage::new(1, 1, vec![0; 4])?;
    assert!(
        ArtifactWriter::publish(
            &directory.0.join("output"),
            &image,
            &image,
            &InvalidReport,
            &ArtifactOptions::fixture()
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(&directory.0)?.count(), 0);
    Ok(())
}

#[test]
fn existing_outputs_and_another_writers_lock_are_not_modified() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let image = RgbaImage::new(1, 1, vec![0; 4])?;
    let output = directory.0.join("output");
    fs::create_dir(&output)?;
    fs::write(output.join("sentinel"), b"owner data")?;
    assert!(
        ArtifactWriter::publish(
            &output,
            &image,
            &image,
            &Report { accepted: true },
            &ArtifactOptions::fixture()
        )
        .is_err()
    );
    assert_eq!(fs::read(output.join("sentinel"))?, b"owner data");
    let second = directory.0.join("second");
    let lock = directory.0.join(".second.publish.lock");
    fs::write(&lock, b"other writer")?;
    assert!(
        ArtifactWriter::publish(
            &second,
            &image,
            &image,
            &Report { accepted: true },
            &ArtifactOptions::fixture()
        )
        .is_err()
    );
    assert_eq!(fs::read(lock)?, b"other writer");
    assert!(!second.exists());
    Ok(())
}

#[test]
fn artifact_budget_rejection_has_no_filesystem_side_effects() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let image = RgbaImage::new(1, 1, vec![0; 4])?;
    let mut options = ArtifactOptions::fixture();
    options.max_output_pixels = 4;
    assert!(matches!(
        ArtifactWriter::publish(
            &directory.0.join("output"),
            &image,
            &image,
            &Report { accepted: true },
            &options
        ),
        Err(CompareError::ResourceLimit(_))
    ));
    assert_eq!(fs::read_dir(&directory.0)?.count(), 0);
    Ok(())
}

#[test]
fn interrupted_staging_cleans_only_its_owned_directory() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    fs::write(directory.0.join("owner.txt"), b"preserved")?;
    {
        let transaction = ArtifactTransaction::begin(&directory.0.join("output"))?;
        transaction.write("partial.png", b"incomplete")?;
        assert_eq!(fs::read_dir(&directory.0)?.count(), 3);
    }
    assert_eq!(fs::read_dir(&directory.0)?.count(), 1);
    assert_eq!(fs::read(directory.0.join("owner.txt"))?, b"preserved");
    Ok(())
}

#[test]
fn transient_windows_rename_errors_publish_complete_staging() -> Result<(), CompareError> {
    for code in [5, 32, 33] {
        let directory = TestDirectory::create()?;
        let mut transaction = directory.staged()?;
        let lock = transaction.lock.clone();
        let mut calls = 0;
        let mut delays = Vec::new();
        transaction.publish_with(
            &ArtifactOptions::fixture().rename,
            true,
            |from, to| {
                calls += 1;
                assert!(lock.is_file());
                assert!(!to.exists());
                for name in ["heatmap.png", "contact-sheet.png", "report.json"] {
                    assert_eq!(fs::read(from.join(name))?, name.as_bytes());
                }
                if calls == 1 {
                    Err(io::Error::from_raw_os_error(code))
                } else {
                    fs::rename(from, to)
                }
            },
            |delay| delays.push(delay),
        )?;
        assert_eq!(calls, 2);
        assert_eq!(delays, [Duration::from_millis(20)]);
        assert!(!transaction.temporary.exists());
        for name in ["heatmap.png", "contact-sheet.png", "report.json"] {
            assert_eq!(fs::read(transaction.output.join(name))?, name.as_bytes());
        }
        drop(transaction);
        assert!(!lock.exists());
        assert_eq!(fs::read_dir(&directory.0)?.count(), 1);
    }
    Ok(())
}

#[test]
fn exhausted_rename_attempts_keep_context_and_clean_owned_staging() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let mut transaction = directory.staged()?;
    let temporary = transaction.temporary.clone();
    let output = transaction.output.clone();
    let lock = transaction.lock.clone();
    let mut calls = 0;
    let mut delays = Vec::new();
    let error = transaction.publish_with(
        &ArtifactRenameOptions {
            max_attempts: 3,
            base_delay_ms: 2,
        },
        true,
        |_, _| {
            calls += 1;
            assert!(lock.is_file());
            assert_eq!(fs::read(temporary.join("report.json"))?, b"report.json");
            Err(io::Error::from_raw_os_error(5))
        },
        |delay| delays.push(delay),
    );
    assert!(
        matches!(error, Err(CompareError::ArtifactRename { from, to, attempts: 3, source })
        if from == temporary && to == output && source.raw_os_error() == Some(5))
    );
    assert_eq!(calls, 3);
    assert_eq!(delays, [Duration::from_millis(2), Duration::from_millis(4)]);
    assert!(!output.exists());
    assert!(temporary.is_dir());
    drop(transaction);
    assert_eq!(fs::read_dir(&directory.0)?.count(), 0);
    Ok(())
}

#[test]
fn a_target_appearing_between_attempts_is_not_replaced() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let mut transaction = directory.staged()?;
    let output = transaction.output.clone();
    let mut calls = 0;
    let error = transaction.publish_with(
        &ArtifactOptions::fixture().rename,
        true,
        |_, to| {
            calls += 1;
            fs::create_dir(to)?;
            fs::write(to.join("owner.txt"), b"other invocation")?;
            Err(io::Error::from_raw_os_error(32))
        },
        |_| {},
    );
    assert!(matches!(error, Err(CompareError::InvalidArgument(message))
        if message.contains("Artifact output already exists")));
    assert_eq!(calls, 1);
    drop(transaction);
    assert_eq!(fs::read(output.join("owner.txt"))?, b"other invocation");
    assert_eq!(fs::read_dir(output)?.count(), 1);
    assert_eq!(fs::read_dir(&directory.0)?.count(), 1);
    Ok(())
}

#[test]
fn unrelated_errors_and_non_windows_platforms_are_not_retried() -> Result<(), CompareError> {
    for (windows, code) in [(true, 2), (true, 80), (false, 5), (false, 32), (false, 33)] {
        let directory = TestDirectory::create()?;
        let mut transaction = directory.staged()?;
        let mut calls = 0;
        let mut delays = Vec::new();
        let error = transaction.publish_with(
            &ArtifactOptions::fixture().rename,
            windows,
            |_, _| {
                calls += 1;
                Err(io::Error::from_raw_os_error(code))
            },
            |delay| delays.push(delay),
        );
        assert!(
            matches!(error, Err(CompareError::ArtifactRename { attempts: 1, source, .. })
            if source.raw_os_error() == Some(code))
        );
        assert_eq!(calls, 1);
        assert!(delays.is_empty());
        drop(transaction);
        assert_eq!(fs::read_dir(&directory.0)?.count(), 0);
    }
    Ok(())
}

#[test]
fn invalid_retry_bounds_have_no_publication_side_effects() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let image = RgbaImage::new(1, 1, vec![0; 4])?;
    for (max_attempts, base_delay_ms) in [(0, 1), (6, 1), (1, 0), (1, 51)] {
        let mut options = ArtifactOptions::fixture();
        options.rename = ArtifactRenameOptions {
            max_attempts,
            base_delay_ms,
        };
        assert!(matches!(
            ArtifactWriter::publish(
                &directory.0.join("output"),
                &image,
                &image,
                &Report { accepted: true },
                &options
            ),
            Err(CompareError::InvalidArgument(_))
        ));
        assert_eq!(fs::read_dir(&directory.0)?.count(), 0);
    }
    Ok(())
}

#[test]
fn artifact_creation_errors_identify_the_operation_and_path() -> Result<(), CompareError> {
    let directory = TestDirectory::create()?;
    let transaction = directory.staged()?;
    let duplicate = transaction.temporary.join("report.json");
    let error = transaction.write("report.json", b"replacement");
    assert!(
        matches!(error, Err(CompareError::IoAt { operation: "create artifact file", path, source })
        if path == duplicate && source.kind() == io::ErrorKind::AlreadyExists)
    );
    assert_eq!(fs::read(duplicate)?, b"report.json");
    drop(transaction);
    assert_eq!(fs::read_dir(&directory.0)?.count(), 0);
    Ok(())
}

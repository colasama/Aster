use std::{fs, path::PathBuf};

use serde::{Serialize, Serializer, ser::Error};
use uuid::Uuid;

use super::{ArtifactOptions, ArtifactTransaction, ArtifactWriter};
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

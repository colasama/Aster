use super::*;
use aster_render_compare::image::ImageLimits;
use aster_render_ir::AntiAliasing;

struct Fixture {
    root: PathBuf,
    frame: FramePlanRequest,
    rgba: Vec<u8>,
}

impl Fixture {
    fn new() -> Result<Self, std::io::Error> {
        let root = std::env::temp_dir().join(format!("aster-png-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root)?;
        let size = Extent2d {
            width: 3,
            height: 1,
        };
        Ok(Self {
            root,
            frame: FramePlanRequest {
                snapshot_scope: "png-test".into(),
                project_revision: 0,
                composition_id: "composition".into(),
                time: 0.25,
                target: size,
                render_target: size,
                anti_aliasing: AntiAliasing::Off,
                shadows_enabled: true,
            },
            rgba: vec![255, 0, 0, 0, 32, 48, 96, 128, 1, 2, 3, 255],
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn sequence_preserves_odd_dimensions_and_alpha_until_atomic_publication()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    let destination = fixture.root.join("sequence");
    let mut output = PngOutput::new(
        destination.clone(),
        ProjectExportFormat::PngSequence,
        fixture.frame.target,
        2,
        Some(4096),
        None,
    )?;
    output.write_frame(0, &fixture.frame, fixture.rgba.clone())?;
    assert!(!destination.try_exists()?);
    assert!(output.finish().is_err());
    assert!(
        output
            .write_frame(0, &fixture.frame, fixture.rgba.clone())
            .is_err()
    );
    output.write_frame(1, &fixture.frame, fixture.rgba.clone())?;
    output.finish()?;
    assert!(output.finish().is_err());
    assert_eq!(fs::read_dir(&destination)?.count(), 2);
    for index in 0..2 {
        let png = fs::read(destination.join(format!("frame_{index:06}.png")))?;
        let decoded = PngCodec::decode(
            &png,
            &ImageLimits {
                max_pixels: 3,
                max_file_bytes: 4096,
            },
        )?;
        assert_eq!((decoded.width, decoded.height), (3, 1));
        assert_eq!(decoded.pixels, fixture.rgba);
    }
    drop(output);
    assert_eq!(fs::read_dir(&fixture.root)?.count(), 1);
    Ok(())
}

#[test]
fn failed_images_remove_staging_and_preserve_racing_destinations()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    for format in [ProjectExportFormat::Png, ProjectExportFormat::PngSequence] {
        let destination = fixture.root.join("output");
        {
            let mut output = PngOutput::new(
                destination.clone(),
                format,
                fixture.frame.target,
                1,
                Some(1),
                None,
            )?;
            assert!(
                output
                    .write_frame(0, &fixture.frame, fixture.rgba.clone())
                    .is_err()
            );
            assert!(!destination.try_exists()?);
        }
        assert_eq!(fs::read_dir(&fixture.root)?.count(), 0);
        {
            let mut output = PngOutput::new(
                destination.clone(),
                format,
                fixture.frame.target,
                1,
                Some(4096),
                None,
            )?;
            output.write_frame(0, &fixture.frame, fixture.rgba.clone())?;
            fs::write(&destination, b"owner-output")?;
            assert!(output.finish().is_err());
        }
        assert_eq!(fs::read(&destination)?, b"owner-output");
        assert_eq!(fs::read_dir(&fixture.root)?.count(), 1);
        assert!(
            PngOutput::new(
                destination.clone(),
                format,
                fixture.frame.target,
                1,
                Some(4096),
                None
            )
            .is_err()
        );
        fs::remove_file(&destination)?;
    }
    Ok(())
}

#[test]
fn streamed_receipts_bind_complete_images_and_clean_failed_long_jobs()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    let receipt_path = fixture.root.join("sequence.receipts.jsonl");
    let destination = fixture.root.join("sequence");
    {
        let mut output = PngOutput::new(
            destination.clone(),
            ProjectExportFormat::PngSequence,
            fixture.frame.target,
            10_000_000,
            Some(4096),
            Some(receipt_path.clone()),
        )?;
        output.write_frame(0, &fixture.frame, fixture.rgba.clone())?;
        assert!(output.frames.is_empty());
        assert!(output.finish().is_err());
    }
    assert!(!receipt_path.try_exists()?);
    assert!(!destination.try_exists()?);
    let mut output = PngOutput::new(
        destination.clone(),
        ProjectExportFormat::PngSequence,
        fixture.frame.target,
        2,
        Some(4096),
        Some(receipt_path.clone()),
    )?;
    for index in 0..2 {
        output.write_frame(index, &fixture.frame, fixture.rgba.clone())?;
    }
    output.finish()?;
    assert!(output.frames.is_empty());
    let receipt = output
        .receipt_file
        .as_ref()
        .ok_or("missing image receipt file")?;
    let bytes = fs::read(&receipt.path)?;
    assert_eq!(receipt.sha256, format!("{:x}", Sha256::digest(&bytes)));
    assert_eq!(receipt.bytes, bytes.len() as u64);
    assert_eq!(receipt.frames, 2);
    assert_eq!(bytes.iter().filter(|b| **b == b'\n').count(), 2);
    drop(output);
    assert!(receipt_path.try_exists()?);
    Ok(())
}

#[test]
fn streamed_png_accounting_crosses_old_disk_caps_and_enforces_explicit_budgets()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::new()?;
    let encoded = PngCodec::encode(&RgbaImage {
        width: fixture.frame.target.width,
        height: fixture.frame.target.height,
        pixels: fixture.rgba.clone(),
    })?;
    let frame_bytes = encoded.len() as u64;
    // Seed only the byte counter to exercise large totals without writing gigabytes of fixtures.
    for preceding in [4_294_967_296, 17_179_869_184] {
        for budget in [None, Some(preceding + frame_bytes)] {
            let destination = fixture.root.join("sequence");
            let receipt_path = fixture.root.join("frames.jsonl");
            {
                let mut output = PngOutput::new(
                    destination.clone(),
                    ProjectExportFormat::PngSequence,
                    fixture.frame.target,
                    2,
                    budget,
                    Some(receipt_path.clone()),
                )?;
                output.bytes = preceding;
                output.write_frame(0, &fixture.frame, fixture.rgba.clone())?;
                assert_eq!(output.bytes, preceding + frame_bytes);
                assert!(output.frames.is_empty());
                if budget.is_some() {
                    assert!(
                        output
                            .write_frame(1, &fixture.frame, fixture.rgba.clone())
                            .is_err()
                    );
                    assert_eq!(output.written, 1);
                    assert!(output.finish().is_err());
                } else {
                    output.write_frame(1, &fixture.frame, fixture.rgba.clone())?;
                    output.finish()?;
                    assert_eq!(fs::read(destination.join("frame_000001.png"))?, encoded);
                }
            }
            if budget.is_some() {
                assert!(!destination.try_exists()?);
                assert!(!receipt_path.try_exists()?);
            } else {
                fs::remove_dir_all(destination)?;
                fs::remove_file(receipt_path)?;
            }
            assert_eq!(fs::read_dir(&fixture.root)?.count(), 0);
        }
    }
    {
        let mut output = PngOutput::new(
            fixture.root.join("overflow"),
            ProjectExportFormat::Png,
            fixture.frame.target,
            1,
            None,
            None,
        )?;
        output.bytes = u64::MAX;
        assert!(
            output
                .write_frame(0, &fixture.frame, fixture.rgba.clone())
                .is_err()
        );
        assert_eq!(output.written, 0);
    }
    assert!(
        PngOutput::new(
            fixture.root.join("zero-budget"),
            ProjectExportFormat::Png,
            fixture.frame.target,
            1,
            Some(0),
            None,
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(&fixture.root)?.count(), 0);
    Ok(())
}

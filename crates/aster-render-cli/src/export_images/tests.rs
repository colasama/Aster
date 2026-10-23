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
        4096,
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
            let mut output =
                PngOutput::new(destination.clone(), format, fixture.frame.target, 1, 1)?;
            assert!(
                output
                    .write_frame(0, &fixture.frame, fixture.rgba.clone())
                    .is_err()
            );
            assert!(!destination.try_exists()?);
        }
        assert_eq!(fs::read_dir(&fixture.root)?.count(), 0);
        {
            let mut output =
                PngOutput::new(destination.clone(), format, fixture.frame.target, 1, 4096)?;
            output.write_frame(0, &fixture.frame, fixture.rgba.clone())?;
            fs::write(&destination, b"owner-output")?;
            assert!(output.finish().is_err());
        }
        assert_eq!(fs::read(&destination)?, b"owner-output");
        assert_eq!(fs::read_dir(&fixture.root)?.count(), 1);
        assert!(
            PngOutput::new(destination.clone(), format, fixture.frame.target, 1, 4096).is_err()
        );
        fs::remove_file(&destination)?;
    }
    Ok(())
}

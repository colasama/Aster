use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use exr::prelude::{AttributeValue, MetaData, SampleType, Text, read_first_rgba_layer_from_file};

use super::*;

impl ExrWriteRequest {
    fn test_root(name: &str) -> PathBuf {
        let sequence = uuid::Uuid::new_v4();
        std::env::temp_dir().join(format!(
            "aster-exr-test-{name}-{}-{sequence}",
            std::process::id()
        ))
    }
}

impl ExrFrame {
    fn sample_pixels() -> Vec<[f32; 4]> {
        vec![
            [-0.25, 0.5, 0.75, 0.75],
            [1.0, 0.0, 0.125, 1.0],
            [8.0, -1.0, 0.0, 1.0],
            [0.125, 0.25, 0.375, 0.5],
        ]
    }
}

impl ExrWriteRequest {
    fn fixture(root: &Path, pixels: &[[f32; 4]], precision: ExrPrecision) -> ExrWriteRequest {
        ExrWriteRequest {
            output_path: root.join("frame.exr"),
            precision,
            frame: ExrFrame {
                width: 2,
                height: 2,
                pixels: Arc::from(pixels),
            },
        }
    }
}

impl ExrFrame {
    fn read_pixels(path: &Path) -> Result<Vec<Vec<[f32; 4]>>, exr::error::Error> {
        Ok(read_first_rgba_layer_from_file(
            path,
            |resolution, _| vec![vec![[0.0; 4]; resolution.width()]; resolution.height()],
            |pixels, position, rgba: (f32, f32, f32, f32)| {
                pixels[position.y()][position.x()] = [rgba.0, rgba.1, rgba.2, rgba.3];
            },
        )?
        .layer_data
        .channel_data
        .pixels)
    }
}

#[test]
fn writes_f16_linear_rgba_and_reads_metadata_and_values_back()
-> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("f16-roundtrip");
    fs::create_dir_all(&root)?;
    let pixels = ExrFrame::sample_pixels();
    let request = ExrWriteRequest::fixture(&root, &pixels, ExrPrecision::F16);
    let report = ExrBackend::default().write_frame(&request, &CancellationToken::default())?;
    assert_eq!((report.width, report.height), (2, 2));
    assert_eq!(report.precision, ExrPrecision::F16);
    assert!(report.bytes_written > 0);

    let metadata = MetaData::read_from_file(&request.output_path, true)?;
    assert_eq!(metadata.headers.len(), 1);
    let header = &metadata.headers[0];
    assert_eq!(header.layer_size, Vec2(2, 2));
    assert_eq!(header.channels.list.len(), 4);
    assert!(
        header
            .channels
            .list
            .iter()
            .all(|channel| channel.sample_type == SampleType::F16)
    );
    assert_eq!(
        header
            .channels
            .list
            .iter()
            .map(|channel| channel.name.to_string())
            .collect::<Vec<_>>(),
        ["A", "B", "G", "R"]
    );
    let alpha = header
        .channels
        .list
        .iter()
        .find(|channel| channel.name == *"A")
        .ok_or("alpha channel missing")?;
    assert!(alpha.quantize_linearly);
    assert!(header.shared_attributes.chromaticities.is_some());
    assert!(matches!(
        header
            .own_attributes
            .other
            .get(&Text::from("asterAlphaMode")),
        Some(AttributeValue::Text(value)) if value == "premultiplied_associated"
    ));
    assert!(matches!(
        header
            .own_attributes
            .other
            .get(&Text::from("asterColorEncoding")),
        Some(AttributeValue::Text(value)) if value == "linear_bt709_d65"
    ));

    let decoded = ExrFrame::read_pixels(&request.output_path)?;
    for (actual, expected) in decoded.iter().flatten().zip(&pixels) {
        for (actual, expected) in actual.iter().zip(expected) {
            assert!((actual - expected).abs() <= 0.002, "{actual} != {expected}");
        }
    }
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn writes_f32_without_quantizing_hdr_values() -> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("f32-roundtrip");
    fs::create_dir_all(&root)?;
    let pixels = ExrFrame::sample_pixels();
    let request = ExrWriteRequest::fixture(&root, &pixels, ExrPrecision::F32);
    ExrBackend::default().write_frame(&request, &CancellationToken::default())?;
    let metadata = MetaData::read_from_file(&request.output_path, true)?;
    assert!(
        metadata.headers[0]
            .channels
            .list
            .iter()
            .all(|channel| channel.sample_type == SampleType::F32)
    );
    assert_eq!(
        ExrFrame::read_pixels(&request.output_path)?[0][0],
        pixels[0]
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn writes_a_safely_named_sequence_frame() -> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("sequence");
    fs::create_dir_all(&root)?;
    let pixels = ExrFrame::sample_pixels();
    let report = ExrBackend::default().write_sequence_frame(
        &ExrSequenceRequest {
            directory: root.clone(),
            file_stem: "beauty-main".into(),
            frame_index: 42,
            zero_padding: 6,
            precision: ExrPrecision::F16,
        },
        ExrFrame {
            width: 2,
            height: 2,
            pixels: Arc::from(pixels.clone()),
        },
        &CancellationToken::default(),
    )?;
    assert_eq!(report.output_path, root.join("beauty-main.000042.exr"));
    assert_eq!(ExrFrame::read_pixels(&report.output_path)?.len(), 2);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn rejects_dimensions_length_memory_paths_and_sequence_traversal()
-> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("bounds");
    fs::create_dir_all(&root)?;
    let pixels = ExrFrame::sample_pixels();
    let mut value = ExrWriteRequest::fixture(&root, &pixels, ExrPrecision::F16);
    value.frame.width = ExrLimits::default().max_width + 1;
    assert!(matches!(
        ExrBackend::default().write_frame(&value, &CancellationToken::default()),
        Err(ExrError::InvalidRequest(_))
    ));
    value.frame.width = 3;
    assert!(matches!(
        ExrBackend::default().write_frame(&value, &CancellationToken::default()),
        Err(ExrError::InvalidRequest(_))
    ));
    value.frame.width = 2;
    value.output_path.set_extension("png");
    assert!(matches!(
        ExrBackend::default().write_frame(&value, &CancellationToken::default()),
        Err(ExrError::InvalidRequest(_))
    ));
    let tight = ExrBackend::with_limits(ExrLimits {
        max_input_bytes: 1,
        ..ExrLimits::default()
    });
    value.output_path.set_extension("exr");
    assert!(matches!(
        tight.write_frame(&value, &CancellationToken::default()),
        Err(ExrError::InvalidRequest(_))
    ));
    let tight_block = ExrBackend::with_limits(ExrLimits {
        max_block_bytes: 1,
        ..ExrLimits::default()
    });
    assert!(matches!(
        tight_block.write_frame(&value, &CancellationToken::default()),
        Err(ExrError::InvalidRequest(_))
    ));
    assert!(
        ExrSequenceRequest {
            directory: root.clone(),
            file_stem: "../escape".into(),
            frame_index: 1,
            zero_padding: 4,
            precision: ExrPrecision::F16,
        }
        .output_path(&ExrLimits::default())
        .is_err()
    );
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn rejects_non_finite_half_overflow_and_invalid_alpha() -> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("pixels");
    fs::create_dir_all(&root)?;
    for (value, precision, channel) in [
        ([f32::NAN, 0.0, 0.0, 1.0], ExrPrecision::F32, "R"),
        ([70_000.0, 0.0, 0.0, 1.0], ExrPrecision::F16, "R"),
        ([0.0, 0.0, 0.0, 1.1], ExrPrecision::F32, "A"),
    ] {
        let mut pixels = ExrFrame::sample_pixels();
        pixels[0] = value;
        assert!(matches!(
            ExrBackend::default().write_frame(
                &ExrWriteRequest::fixture(&root, &pixels, precision),
                &CancellationToken::default()
            ),
            Err(ExrError::InvalidPixel { channel: actual, .. }) if actual == channel
        ));
    }
    assert!(fs::read_dir(&root)?.next().is_none());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn cancellation_and_output_limit_leave_no_partial_file() -> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("cancel-limit");
    fs::create_dir_all(&root)?;
    let pixels = ExrFrame::sample_pixels();
    let value = ExrWriteRequest::fixture(&root, &pixels, ExrPrecision::F16);
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert_eq!(
        ExrBackend::default().write_frame(&value, &cancellation),
        Err(ExrError::Cancelled)
    );
    assert!(!value.output_path.exists());

    let (temporary, file) = AtomicFile::stage(&value.output_path)?;
    let overflowed = Arc::new(AtomicBool::new(false));
    let mut writer = BoundedCancellableFile {
        file,
        cancellation: cancellation.clone(),
        max_written_bytes: 1024,
        position: 0,
        max_extent: 0,
        overflowed,
    };
    assert_eq!(
        writer
            .write_all(b"cancelled")
            .err()
            .ok_or("expected I/O failure")?
            .kind(),
        io::ErrorKind::Other
    );
    drop(writer);
    drop(temporary);

    let limited = ExrBackend::with_limits(ExrLimits {
        max_output_bytes: 8,
        ..ExrLimits::default()
    });
    assert_eq!(
        limited.write_frame(&value, &CancellationToken::default()),
        Err(ExrError::OutputTooLarge { limit: 8 })
    );
    assert!(!value.output_path.exists());
    assert!(fs::read_dir(&root)?.next().is_none());
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn bounded_writer_allows_offset_backpatch_without_double_counting()
-> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("backpatch");
    fs::create_dir_all(&root)?;
    let output = root.join("writer.bin");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    let overflowed = Arc::new(AtomicBool::new(false));
    let mut writer = BoundedCancellableFile {
        file,
        cancellation: CancellationToken::default(),
        max_written_bytes: 8,
        position: 0,
        max_extent: 0,
        overflowed: overflowed.clone(),
    };
    writer.write_all(b"12345678")?;
    assert_eq!(writer.seek(SeekFrom::End(-4))?, 4);
    writer.write_all(b"ABCD")?;
    assert_eq!(writer.seek(SeekFrom::Current(-8))?, 0);
    assert_eq!(writer.max_extent, 8);
    assert!(!overflowed.load(Ordering::Acquire));
    drop(writer);
    assert_eq!(fs::read(&output)?, b"1234ABCD");
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn bounded_writer_rejects_forward_seek_and_write_past_limit()
-> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("seek-limit");
    fs::create_dir_all(&root)?;
    let output = root.join("writer.bin");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)?;
    let overflowed = Arc::new(AtomicBool::new(false));
    let mut writer = BoundedCancellableFile {
        file,
        cancellation: CancellationToken::default(),
        max_written_bytes: 8,
        position: 0,
        max_extent: 0,
        overflowed: overflowed.clone(),
    };
    assert_eq!(
        writer
            .seek(SeekFrom::Start(9))
            .err()
            .ok_or("expected I/O failure")?
            .kind(),
        io::ErrorKind::Other
    );
    assert_eq!(writer.position, 0);
    assert_eq!(writer.seek(SeekFrom::Start(7))?, 7);
    assert_eq!(
        writer
            .write_all(b"XX")
            .err()
            .ok_or("expected I/O failure")?
            .kind(),
        io::ErrorKind::Other
    );
    assert_eq!(writer.position, 7);
    assert!(overflowed.load(Ordering::Acquire));
    drop(writer);
    assert_eq!(fs::metadata(&output)?.len(), 0);
    fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn atomic_publish_does_not_clobber_a_racing_output() -> Result<(), Box<dyn std::error::Error>> {
    let root = ExrWriteRequest::test_root("race");
    fs::create_dir_all(&root)?;
    let output = root.join("frame.exr");
    let (temporary, file) = AtomicFile::stage(&output)?;
    drop(file);
    let directory = temporary.temporary.clone();
    fs::write(&temporary.temporary, b"encoded")?;
    fs::write(&output, b"race winner")?;
    assert!(
        matches!(temporary.publish(false), Err(error) if error.kind() == io::ErrorKind::AlreadyExists)
    );
    assert_eq!(fs::read(&output)?, b"race winner");
    assert!(!directory.exists());
    fs::remove_dir_all(root)?;
    Ok(())
}

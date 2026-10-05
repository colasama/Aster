use crate::{CancellationToken, FfmpegBackend, FfmpegError, StillEncoding};
use std::sync::Arc;

#[test]
fn encoded_extent_and_malformed_segments_are_checked_before_spawn() -> Result<(), FfmpegError> {
    let jpeg = vec![
        0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xc0, 0, 8, 8, 0, 4, 0, 8, 1,
    ];
    assert_eq!(StillEncoding::detect(&jpeg)?.dimensions(&jpeg)?, (8, 4));
    let backend = FfmpegBackend::new("nonexistent-ffmpeg");
    // Equal byte counts with different geometry must never reach the codec.
    let error = backend.decode_still_rgba(
        Arc::from(jpeg.clone()),
        (4, 8),
        &CancellationToken::default(),
    );
    assert!(matches!(error, Err(FfmpegError::InvalidMetadata(_))));
    let mut truncated = jpeg;
    truncated[4] = 0xff;
    assert!(StillEncoding::Jpeg.dimensions(&truncated).is_err());
    assert!(StillEncoding::Png.dimensions(b"\x89PNG\r\n\x1a\n").is_err());
    assert!(StillEncoding::detect(b"unknown").is_err());
    Ok(())
}

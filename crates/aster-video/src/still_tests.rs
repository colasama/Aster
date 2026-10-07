use crate::{CancellationToken, FfmpegBackend, FfmpegError, StillEncoding};
use std::sync::Arc;

struct WebpFixture;

impl WebpFixture {
    fn riff(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut bytes = b"RIFF\0\0\0\0WEBP".to_vec();
        for (tag, data) in chunks {
            bytes.extend_from_slice(*tag);
            bytes.extend((data.len() as u32).to_le_bytes());
            bytes.extend_from_slice(data);
            if data.len() % 2 == 1 {
                bytes.push(0);
            }
        }
        let length = bytes.len() as u32 - 8;
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        bytes
    }
}

#[test]
fn webp_admission_checks_all_extents_and_chunk_boundaries() -> Result<(), FfmpegError> {
    let lossy = [0, 0, 0, 0x9d, 1, 0x2a, 8, 0, 4, 0];
    let lossless = [0x2f, 7, 0xc0, 0, 0];
    let extended = [0x10, 0, 0, 0, 7, 0, 0, 3, 0, 0];
    for chunks in [
        vec![(b"VP8 ", lossy.as_slice())],
        vec![(b"VP8L", lossless.as_slice())],
        vec![
            (b"VP8X", extended.as_slice()),
            (b"ALPH", &[0, 0]),
            (b"VP8 ", lossy.as_slice()),
        ],
    ] {
        let bytes = WebpFixture::riff(&chunks);
        assert_eq!(StillEncoding::detect(&bytes)?.dimensions(&bytes)?, (8, 4));
        let backend = FfmpegBackend::new("nonexistent-ffmpeg");
        assert!(matches!(
            backend.decode_still_rgba(
                Arc::from(bytes.clone()),
                (4, 8),
                &CancellationToken::default()
            ),
            Err(FfmpegError::InvalidMetadata(_))
        ));
        for end in 0..bytes.len() {
            assert!(StillEncoding::Webp.dimensions(&bytes[..end]).is_err());
        }
    }
    let mut mismatch = extended;
    mismatch[4] = 8;
    let mut animated = extended;
    animated[0] |= 2;
    for header in [mismatch, animated] {
        assert!(
            StillEncoding::Webp
                .dimensions(&WebpFixture::riff(&[(b"VP8X", &header), (b"VP8 ", &lossy)]))
                .is_err()
        );
    }
    assert!(
        StillEncoding::Webp
            .dimensions(&WebpFixture::riff(&[(b"VP8 ", &lossy), (b"VP8 ", &lossy)]))
            .is_err()
    );
    assert!(
        StillEncoding::Webp
            .dimensions(&WebpFixture::riff(&[(b"VP8 ", &lossy), (b"ANMF", &[])]))
            .is_err()
    );
    Ok(())
}

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

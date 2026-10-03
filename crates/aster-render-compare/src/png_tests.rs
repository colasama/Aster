use std::io::Write;

use flate2::{Compression, write::ZlibEncoder};

use super::PngCodec;
use crate::{
    error::CompareError,
    image::{ImageLimits, RgbaImage},
};

struct Fixture {
    width: u32,
    height: u32,
    color: u8,
    rows: Vec<u8>,
    before: Vec<Vec<u8>>,
    after: Vec<Vec<u8>>,
}

impl Default for Fixture {
    fn default() -> Self {
        Self {
            width: 1,
            height: 1,
            color: 6,
            rows: vec![0, 20, 30, 40, 0],
            before: Vec::new(),
            after: Vec::new(),
        }
    }
}

impl Fixture {
    fn limits() -> ImageLimits {
        ImageLimits {
            max_pixels: 1_000_000,
            max_file_bytes: 10_000_000,
        }
    }

    fn chunk(kind: &[u8; 4], payload: &[u8]) -> Result<Vec<u8>, CompareError> {
        let length =
            u32::try_from(payload.len()).map_err(|error| CompareError::Codec(error.to_string()))?;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(kind);
        bytes.extend_from_slice(payload);
        let checksum = crc32fast::hash(&bytes[4..]);
        bytes.extend_from_slice(&checksum.to_be_bytes());
        Ok(bytes)
    }

    fn header(&self) -> Vec<u8> {
        let mut header = Vec::new();
        header.extend_from_slice(&self.width.to_be_bytes());
        header.extend_from_slice(&self.height.to_be_bytes());
        header.extend_from_slice(&[8, self.color, 0, 0, 0]);
        header
    }

    fn compressed(&self) -> Result<Vec<u8>, CompareError> {
        let mut compressor = ZlibEncoder::new(Vec::new(), Compression::fast());
        compressor.write_all(&self.rows)?;
        Ok(compressor.finish()?)
    }

    fn with_data(&self, header: &[u8], data: &[u8]) -> Result<Vec<u8>, CompareError> {
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(Self::chunk(b"IHDR", header)?);
        for chunk in &self.before {
            png.extend(chunk);
        }
        png.extend(Self::chunk(b"IDAT", data)?);
        for chunk in &self.after {
            png.extend(chunk);
        }
        png.extend(Self::chunk(b"IEND", &[])?);
        Ok(png)
    }

    fn bytes(&self) -> Result<Vec<u8>, CompareError> {
        let header = self.header();
        let compressed = self.compressed()?;
        self.with_data(&header, &compressed)
    }
}

#[test]
fn image_validation_checks_layout_and_both_members_of_a_pair() -> Result<(), CompareError> {
    assert!(RgbaImage::new(0, 1, vec![]).is_err());
    assert!(RgbaImage::new(1, 0, vec![]).is_err());
    assert!(RgbaImage::new(u32::MAX, u32::MAX, vec![]).is_err());
    assert!(RgbaImage::new(1, 1, vec![0; 3]).is_err());
    let first = RgbaImage::new(1, 1, vec![0; 4])?;
    first.validate_pair(&first)?;
    assert!(
        first
            .validate_pair(&RgbaImage::new(2, 1, vec![0; 8])?)
            .is_err()
    );
    assert!(
        first
            .validate_pair(&RgbaImage {
                width: 1,
                height: 1,
                pixels: vec![]
            })
            .is_err()
    );
    Ok(())
}

#[test]
fn roundtrip_preserves_all_alpha_values_and_rgb_beneath_zero_alpha() -> Result<(), CompareError> {
    let mut pixels = Vec::new();
    for value in 0..=255_u8 {
        pixels.extend_from_slice(&[value, 255 - value, value.wrapping_mul(17), value]);
        pixels.extend_from_slice(&[value, 255 - value, value.wrapping_mul(29), 0]);
    }
    let image = RgbaImage::new(256, 2, pixels)?;
    let encoded = PngCodec::encode(&image)?;
    assert_eq!(PngCodec::decode(&encoded, &Fixture::limits())?, image);
    assert_eq!(PngCodec::encode(&image)?, encoded);
    Ok(())
}

#[test]
fn decodes_fixed_node_zlib_fixture_without_altering_transparent_rgb() -> Result<(), CompareError> {
    // Encoded independently by scripts/parity/png.mjs with Node's zlib implementation.
    let bytes = [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, 6,
        0, 0, 0, 114, 182, 13, 36, 0, 0, 0, 26, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 206,
        192, 120, 130, 249, 63, 131, 136, 220, 135, 134, 40, 35, 78, 70, 0, 48, 145, 5, 10, 85,
        191, 119, 16, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
    ];
    let expected = RgbaImage::new(
        2,
        2,
        vec![255, 0, 7, 0, 1, 200, 3, 255, 20, 30, 240, 128, 90, 50, 9, 1],
    )?;
    assert_eq!(PngCodec::decode(&bytes, &Fixture::limits())?, expected);
    Ok(())
}

#[test]
fn every_row_filter_handles_rgb_rgba_and_wrapped_residuals() -> Result<(), CompareError> {
    let expected_rgb = [
        5, 7, 11, 13, 17, 19, 23, 29, 31, 3, 11, 9, 19, 13, 23, 29, 31, 41,
    ];
    let filtered_rows = [
        [
            [5, 7, 11, 13, 17, 19, 23, 29, 31],
            [3, 11, 9, 19, 13, 23, 29, 31, 41],
        ],
        [
            [5, 7, 11, 8, 10, 8, 10, 12, 12],
            [3, 11, 9, 16, 2, 14, 10, 18, 18],
        ],
        [
            [5, 7, 11, 13, 17, 19, 23, 29, 31],
            [254, 4, 254, 6, 252, 4, 6, 2, 10],
        ],
        [
            [5, 7, 11, 11, 14, 14, 17, 21, 22],
            [1, 8, 4, 11, 255, 9, 8, 10, 14],
        ],
        [
            [5, 7, 11, 8, 10, 8, 10, 12, 12],
            [254, 4, 254, 6, 252, 4, 6, 2, 10],
        ],
    ];
    for (filter, rows) in filtered_rows.iter().enumerate() {
        for color in [2, 6] {
            let mut encoded_rows = Vec::new();
            for row in rows {
                encoded_rows.push(filter as u8);
                for rgb in row.chunks_exact(3) {
                    encoded_rows.extend_from_slice(rgb);
                    if color == 6 {
                        encoded_rows.push(0);
                    }
                }
            }
            let fixture = Fixture {
                width: 3,
                height: 2,
                color,
                rows: encoded_rows,
                ..Fixture::default()
            };
            let mut expected = Vec::new();
            for rgb in expected_rgb.chunks_exact(3) {
                expected.extend_from_slice(rgb);
                expected.push(if color == 6 { 0 } else { 255 });
            }
            let decoded = PngCodec::decode(&fixture.bytes()?, &Fixture::limits())?;
            assert_eq!(decoded.pixels, expected, "filter {filter}, color {color}");
        }
    }
    Ok(())
}

#[test]
fn paeth_uses_upper_left_predictor_with_four_channel_stride() -> Result<(), CompareError> {
    let fixture = Fixture {
        width: 2,
        height: 2,
        rows: vec![
            4, 100, 100, 100, 100, 50, 50, 50, 50, 4, 206, 206, 206, 206, 100, 100, 100, 100,
        ],
        ..Fixture::default()
    };
    assert_eq!(
        PngCodec::decode(&fixture.bytes()?, &Fixture::limits())?.pixels,
        [
            100, 100, 100, 100, 150, 150, 150, 150, 50, 50, 50, 50, 200, 200, 200, 200
        ]
    );
    Ok(())
}

#[test]
fn consecutive_idat_and_ancillary_metadata_preserve_raw_channel_values() -> Result<(), CompareError>
{
    let fixture = Fixture::default();
    let compressed = fixture.compressed()?;
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(Fixture::chunk(b"IHDR", &fixture.header())?);
    bytes.extend(Fixture::chunk(b"gAMA", &[0, 0, 177, 143])?);
    bytes.extend(Fixture::chunk(b"IDAT", &compressed[..3])?);
    bytes.extend(Fixture::chunk(b"IDAT", &[])?);
    bytes.extend(Fixture::chunk(b"IDAT", &compressed[3..])?);
    bytes.extend(Fixture::chunk(b"tEXt", b"Author\0Aster")?);
    bytes.extend(Fixture::chunk(b"IEND", &[])?);
    assert_eq!(
        PngCodec::decode(&bytes, &Fixture::limits())?.pixels,
        [20, 30, 40, 0]
    );
    Ok(())
}

#[test]
fn corrupt_crc_truncation_and_trailing_bytes_are_rejected() -> Result<(), CompareError> {
    let original = Fixture::default().bytes()?;
    for offset in [0, 29] {
        let mut bytes = original.clone();
        bytes[offset] ^= 1;
        assert!(PngCodec::decode(&bytes, &Fixture::limits()).is_err());
    }
    for end in 0..original.len() {
        assert!(
            PngCodec::decode(&original[..end], &Fixture::limits()).is_err(),
            "length {end}"
        );
    }
    let mut extra = original;
    extra.push(0);
    assert!(PngCodec::decode(&extra, &Fixture::limits()).is_err());
    Ok(())
}

#[test]
fn dimensions_and_file_budgets_are_checked_before_decompression() -> Result<(), CompareError> {
    for (width, height) in [(0, 1), (1, 0), (1_000_001, 1), (u32::MAX, u32::MAX)] {
        let fixture = Fixture {
            width,
            height,
            ..Fixture::default()
        };
        assert!(PngCodec::decode(&fixture.bytes()?, &Fixture::limits()).is_err());
    }
    let bytes = Fixture::default().bytes()?;
    assert!(matches!(
        PngCodec::decode(
            &bytes,
            &ImageLimits {
                max_pixels: 1,
                max_file_bytes: bytes.len() - 1
            }
        ),
        Err(CompareError::ResourceLimit(_))
    ));
    assert!(matches!(
        PngCodec::decode(
            &bytes,
            &ImageLimits {
                max_pixels: 0,
                max_file_bytes: bytes.len()
            }
        ),
        Err(CompareError::InvalidArgument(_))
    ));
    assert!(
        PngCodec::decode(
            &[
                137, 80, 78, 71, 13, 10, 26, 10, 128, 0, 0, 0, 73, 72, 68, 82, 0, 0, 0, 0
            ],
            &Fixture::limits()
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn unsupported_formats_and_invalid_chunk_orders_are_rejected() -> Result<(), CompareError> {
    let fixture = Fixture::default();
    for (field, value) in [(8, 16), (9, 0), (9, 3), (9, 4), (10, 1), (11, 1), (12, 1)] {
        let mut header = fixture.header();
        header[field] = value;
        assert!(
            PngCodec::decode(
                &fixture.with_data(&header, &fixture.compressed()?)?,
                &Fixture::limits()
            )
            .is_err()
        );
    }
    for (kind, data) in [
        (*b"IHDR", fixture.header()),
        (*b"ABCD", vec![]),
        (*b"te1t", vec![]),
        (*b"test", vec![]),
        (*b"tRNS", vec![0; 6]),
        (*b"acTL", vec![0; 8]),
        (*b"fcTL", vec![0; 26]),
        (*b"fdAT", vec![0; 4]),
        (*b"PLTE", vec![0; 2]),
    ] {
        let malformed = Fixture {
            before: vec![Fixture::chunk(&kind, &data)?],
            ..Fixture::default()
        };
        assert!(
            PngCodec::decode(&malformed.bytes()?, &Fixture::limits()).is_err(),
            "kind {kind:?}"
        );
    }
    let nonconsecutive = Fixture {
        after: vec![
            Fixture::chunk(b"tEXt", b"a\0b")?,
            Fixture::chunk(b"IDAT", &[])?,
        ],
        ..Fixture::default()
    };
    assert!(PngCodec::decode(&nonconsecutive.bytes()?, &Fixture::limits()).is_err());
    let nonempty_end = Fixture {
        after: vec![Fixture::chunk(b"IEND", &[0])?],
        ..Fixture::default()
    };
    assert!(PngCodec::decode(&nonempty_end.bytes()?, &Fixture::limits()).is_err());
    Ok(())
}

#[test]
fn decompression_bomb_invalid_filters_and_trailing_zlib_streams_are_rejected()
-> Result<(), CompareError> {
    let bomb = Fixture {
        rows: vec![0; 100_000],
        ..Fixture::default()
    };
    assert!(matches!(
        PngCodec::decode(&bomb.bytes()?, &Fixture::limits()),
        Err(CompareError::ResourceLimit(_))
    ));
    for rows in [vec![0, 20, 30, 40], vec![5, 20, 30, 40, 50]] {
        assert!(
            PngCodec::decode(
                &Fixture {
                    rows,
                    ..Fixture::default()
                }
                .bytes()?,
                &Fixture::limits()
            )
            .is_err()
        );
    }
    let fixture = Fixture::default();
    let mut compressed = fixture.compressed()?;
    compressed.extend(fixture.compressed()?);
    assert!(
        PngCodec::decode(
            &fixture.with_data(&fixture.header(), &compressed)?,
            &Fixture::limits()
        )
        .is_err()
    );
    assert!(
        PngCodec::decode(
            &fixture.with_data(&fixture.header(), &[0, 1, 2])?,
            &Fixture::limits()
        )
        .is_err()
    );
    Ok(())
}

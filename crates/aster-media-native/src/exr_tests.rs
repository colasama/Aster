use crate::{StillLimits, exr_snapshot::ExrSnapshot};
use aster_render_ir::{MediaFrameDescriptor, MediaSample, MediaTextureFormat, ResourceHash};
use aster_video::CancellationToken;
use base64::Engine;
use exr::prelude::{Image, SpecificChannels, WritableImage, f16};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Cursor};

#[derive(Deserialize)]
struct Catalog {
    assets: BTreeMap<String, Asset>,
}
#[derive(Deserialize)]
struct Asset {
    data: String,
    sha256: String,
    #[serde(default)]
    width: u32,
    #[serde(default)]
    height: u32,
    #[serde(rename = "linearSamples", default)]
    samples: Vec<LinearSample>,
}
#[derive(Deserialize)]
struct LinearSample {
    x: usize,
    y: usize,
    rgb: [f32; 3],
}

struct ExrFixture;
impl ExrFixture {
    fn limits() -> StillLimits {
        StillLimits {
            still_max_source_bytes: 1_048_576,
            still_max_pixel_bytes: 1_048_576,
            still_max_dimension: 1024,
            still_timeout_ms: 30000,
            still_max_header_bytes: 65536,
        }
    }
    fn frame(width: u32, height: u32) -> MediaFrameDescriptor {
        MediaFrameDescriptor {
            source: ResourceHash("a".repeat(64)),
            sample: MediaSample::Image,
            width,
            height,
            format: MediaTextureFormat::Rgba16Float,
        }
    }
    fn encode(sample: (f32, f32, f32, f32)) -> Result<Vec<u8>, exr::error::Error> {
        let mut output = Cursor::new(Vec::new());
        Image::from_channels((2, 1), SpecificChannels::rgba(move |_| sample))
            .write()
            .non_parallel()
            .to_buffered(&mut output)?;
        Ok(output.into_inner())
    }
}

#[test]
fn real_exr_catalog_samples_remain_linear() -> Result<(), Box<dyn std::error::Error>> {
    let catalog: Catalog = serde_json::from_str(include_str!(
        "../../../tests/parity/assets/media-assets.json"
    ))?;
    let asset = catalog
        .assets
        .get("pattern.exr")
        .ok_or("missing EXR fixture")?;
    let encoded = base64::engine::general_purpose::STANDARD.decode(&asset.data)?;
    assert_eq!(format!("{:x}", Sha256::digest(&encoded)), asset.sha256);
    let pixels = ExrSnapshot::decode(
        encoded,
        &ExrFixture::frame(asset.width, asset.height),
        &ExrFixture::limits(),
        &CancellationToken::default(),
    )?;
    assert_eq!(
        pixels.len(),
        asset.width as usize * asset.height as usize * 8
    );
    for sample in &asset.samples {
        let offset = (sample.y * asset.width as usize + sample.x) * 8;
        for (channel, expected) in sample.rgb.iter().enumerate() {
            let index = offset + channel * 2;
            let actual =
                f16::from_bits(u16::from_le_bytes([pixels[index], pixels[index + 1]])).to_f32();
            assert!(
                (actual - expected).abs() <= 0.0005,
                "linear channel differs: {actual} vs {expected}"
            );
        }
    }
    Ok(())
}

#[test]
fn exr_preserves_hdr_negative_samples_and_unassociates_alpha()
-> Result<(), Box<dyn std::error::Error>> {
    let frame = ExrFixture::frame(2, 1);
    let bytes = ExrFixture::encode((4.0, -2.0, 0.25, 0.5))?;
    let pixels = ExrSnapshot::decode(
        bytes.clone(),
        &frame,
        &ExrFixture::limits(),
        &CancellationToken::default(),
    )?;
    let actual: Vec<_> = pixels
        .chunks_exact(2)
        .map(|pair| f16::from_bits(u16::from_le_bytes([pair[0], pair[1]])).to_f32())
        .collect();
    assert_eq!(actual, [8.0, -4.0, 0.5, 0.5].repeat(2));
    assert!(
        ExrSnapshot::decode(
            bytes.clone(),
            &ExrFixture::frame(1, 2),
            &ExrFixture::limits(),
            &CancellationToken::default()
        )
        .is_err()
    );
    assert!(
        ExrSnapshot::decode(
            bytes.clone(),
            &frame,
            &StillLimits {
                still_max_header_bytes: 16,
                ..ExrFixture::limits()
            },
            &CancellationToken::default()
        )
        .is_err()
    );
    let cancelled = CancellationToken::default();
    cancelled.cancel();
    assert!(ExrSnapshot::decode(bytes, &frame, &ExrFixture::limits(), &cancelled).is_err());
    let invalid = ExrFixture::encode((f32::INFINITY, 0.0, 0.0, 1.0))?;
    assert!(
        ExrSnapshot::decode(
            invalid,
            &frame,
            &ExrFixture::limits(),
            &CancellationToken::default()
        )
        .is_err()
    );
    Ok(())
}

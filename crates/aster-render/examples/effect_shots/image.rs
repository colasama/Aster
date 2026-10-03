use std::{
    fs,
    io::Write,
    path::Path,
    sync::mpsc,
    time::{Duration, Instant},
};

use flate2::{Compression, write::ZlibEncoder};
use sha2::{Digest, Sha256};

use super::{HEIGHT, WIDTH};

pub struct ImageOutput;

impl ImageOutput {
    pub fn map_readback(
        device: &wgpu::Device,
        buffer: &wgpu::Buffer,
        submission: wgpu::SubmissionIndex,
    ) -> Result<Vec<u8>, String> {
        let slice = buffer.slice(..);
        let (tx, rx) = mpsc::sync_channel(1);
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        let started = Instant::now();
        device
            .poll(wgpu::PollType::Wait {
                submission_index: Some(submission),
                timeout: Some(Duration::from_secs(30)),
            })
            .map_err(|error| format!("submission did not complete: {error:?}"))?;
        rx.recv_timeout(Duration::from_secs(30).saturating_sub(started.elapsed()))
            .map_err(|error| format!("readback timed out: {error}"))?
            .map_err(|error| format!("readback mapping failed: {error}"))?;
        let mapped = slice
            .get_mapped_range()
            .map_err(|error| format!("map failed: {error}"))?;
        let pixels = mapped.to_vec();
        drop(mapped);
        buffer.unmap();
        Ok(pixels)
    }

    /// The shader outputs premultiplied sRGB; composite it over a checkerboard so
    /// effects that only change alpha remain visible.
    pub fn over_checkerboard(pixels: &[u8]) -> Vec<u8> {
        let mut rgb = Vec::with_capacity((WIDTH * HEIGHT * 3) as usize);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let offset = ((y * WIDTH + x) * 4) as usize;
                let alpha = pixels[offset + 3] as f32 / 255.0;
                let backdrop = if (x / 8 + y / 8) % 2 == 0 { 0.25 } else { 0.38 };
                for channel in 0..3 {
                    let source = pixels[offset + channel] as f32 / 255.0;
                    rgb.push(((source + backdrop * (1.0 - alpha)) * 255.0) as u8);
                }
            }
        }
        rgb
    }

    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xffff_ffffu32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 {
                    (crc >> 1) ^ 0xedb8_8320
                } else {
                    crc >> 1
                };
            }
        }
        crc ^ 0xffff_ffff
    }

    fn png_chunk(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut chunk = (payload.len() as u32).to_be_bytes().to_vec();
        chunk.extend_from_slice(kind);
        chunk.extend_from_slice(payload);
        chunk.extend_from_slice(&Self::crc32(&chunk[4..]).to_be_bytes());
        chunk
    }

    pub fn write_png(path: &Path, width: u32, height: u32, rgb: &[u8]) -> Result<String, String> {
        let mut raw = Vec::with_capacity(((width * 3 + 1) * height) as usize);
        for y in 0..height {
            raw.push(0);
            let row = (y * width * 3) as usize;
            raw.extend_from_slice(&rgb[row..row + (width * 3) as usize]);
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
        encoder
            .write_all(&raw)
            .map_err(|error| format!("deflate failed: {error}"))?;
        let compressed = encoder
            .finish()
            .map_err(|error| format!("deflate failed: {error}"))?;
        let mut ihdr = width.to_be_bytes().to_vec();
        ihdr.extend_from_slice(&height.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let png = [
            b"\x89PNG\r\n\x1a\n".as_slice(),
            &Self::png_chunk(b"IHDR", &ihdr),
            &Self::png_chunk(b"IDAT", &compressed),
            &Self::png_chunk(b"IEND", &[]),
        ]
        .concat();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| format!("creating PNG failed: {error}"))?;
        file.write_all(&png)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("writing PNG failed: {error}"))?;
        Ok(format!("{:x}", Sha256::digest(&png)))
    }
}

use std::io::Write;

use flate2::{Compression, Decompress, FlushDecompress, Status, write::ZlibEncoder};

use crate::{
    error::CompareError,
    image::{ImageLimits, RgbaImage},
};

pub struct PngCodec;

impl PngCodec {
    /// Decodes raw code values without color conversion or alpha premultiplication.
    pub fn decode(bytes: &[u8], limits: &ImageLimits) -> Result<RgbaImage, CompareError> {
        limits.validate()?;
        if bytes.len() > limits.max_file_bytes {
            return Err(CompareError::ResourceLimit(
                "PNG encoded byte budget exceeded".into(),
            ));
        }
        if bytes.get(..8) != Some(b"\x89PNG\r\n\x1a\n") {
            return Err(CompareError::Codec("Invalid PNG signature".into()));
        }
        let mut header = None;
        let mut compressed = Vec::new();
        let mut palette = false;
        let mut started = false;
        let mut ended = false;
        let mut finished = false;
        let mut offset = 8;
        while offset < bytes.len() {
            if bytes.len() - offset < 12 {
                return Err(CompareError::Codec("Truncated PNG chunk header".into()));
            }
            let length = u32::from_be_bytes(
                bytes[offset..offset + 4]
                    .try_into()
                    .map_err(|_| CompareError::Codec("Invalid PNG chunk length field".into()))?,
            );
            if length > 0x7fff_ffff {
                return Err(CompareError::Codec("Invalid PNG chunk length".into()));
            }
            let payload_end = offset
                .checked_add(8)
                .and_then(|value| value.checked_add(length as usize))
                .ok_or_else(|| CompareError::Codec("PNG chunk length overflow".into()))?;
            let chunk_end = payload_end
                .checked_add(4)
                .filter(|end| *end <= bytes.len())
                .ok_or_else(|| CompareError::Codec("Truncated PNG chunk payload".into()))?;
            let kind = &bytes[offset + 4..offset + 8];
            if !kind.iter().all(u8::is_ascii_alphabetic) || !kind[2].is_ascii_uppercase() {
                return Err(CompareError::Codec("Invalid PNG chunk type".into()));
            }
            let checksum = u32::from_be_bytes(
                bytes[payload_end..chunk_end]
                    .try_into()
                    .map_err(|_| CompareError::Codec("Invalid PNG checksum field".into()))?,
            );
            if crc32fast::hash(&bytes[offset + 4..payload_end]) != checksum {
                return Err(CompareError::Codec("PNG chunk CRC mismatch".into()));
            }
            let data = &bytes[offset + 8..payload_end];
            if header.is_none() && kind != b"IHDR" {
                return Err(CompareError::Codec(
                    "PNG IHDR must be the first chunk".into(),
                ));
            }
            match kind {
                b"IHDR" => {
                    if header.is_some() {
                        return Err(CompareError::Codec("Duplicate PNG IHDR chunk".into()));
                    }
                    header = Some(PngHeader::parse(data, limits)?);
                }
                b"IDAT" => {
                    if ended {
                        return Err(CompareError::Codec(
                            "PNG IDAT chunks must be consecutive".into(),
                        ));
                    }
                    started = true;
                    compressed.try_reserve(data.len()).map_err(|error| {
                        CompareError::ResourceLimit(format!(
                            "PNG compressed allocation failed: {error}"
                        ))
                    })?;
                    compressed.extend_from_slice(data);
                }
                _ => {
                    if started {
                        ended = true;
                    }
                    match kind {
                        b"IEND" => {
                            if !data.is_empty() {
                                return Err(CompareError::Codec("PNG IEND must be empty".into()));
                            }
                            if !started {
                                return Err(CompareError::Codec(
                                    "PNG has no IDAT image data".into(),
                                ));
                            }
                            if chunk_end != bytes.len() {
                                return Err(CompareError::Codec(
                                    "PNG has trailing data after IEND".into(),
                                ));
                            }
                            finished = true;
                        }
                        b"PLTE" => {
                            if palette
                                || started
                                || data.is_empty()
                                || data.len() > 768
                                || !data.len().is_multiple_of(3)
                            {
                                return Err(CompareError::Codec("Invalid PNG PLTE chunk".into()));
                            }
                            palette = true;
                        }
                        b"tRNS" => {
                            return Err(CompareError::Codec(
                                "PNG tRNS transparency is unsupported; use RGBA8".into(),
                            ));
                        }
                        b"acTL" | b"fcTL" | b"fdAT" => {
                            return Err(CompareError::Codec("Animated PNG is unsupported".into()));
                        }
                        _ if kind[0].is_ascii_uppercase() => {
                            return Err(CompareError::Codec(
                                "Unsupported PNG critical chunk".into(),
                            ));
                        }
                        _ => {}
                    }
                }
            }
            offset = chunk_end;
        }
        let header = header
            .filter(|_| finished)
            .ok_or_else(|| CompareError::Codec("PNG is missing IHDR or IEND".into()))?;
        header.inflate(&compressed)
    }

    pub fn encode(image: &RgbaImage) -> Result<Vec<u8>, CompareError> {
        image.validate()?;
        if image.width > 0x7fff_ffff || image.height > 0x7fff_ffff {
            return Err(CompareError::InvalidImage(
                "PNG dimensions exceed the format limit".into(),
            ));
        }
        let row_bytes = image.pixels.len() / image.height as usize;
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
        for row in image.pixels.chunks_exact(row_bytes) {
            encoder.write_all(&[0])?;
            encoder.write_all(row)?;
        }
        let compressed = encoder.finish()?;
        let mut header = Vec::with_capacity(13);
        header.extend_from_slice(&image.width.to_be_bytes());
        header.extend_from_slice(&image.height.to_be_bytes());
        header.extend_from_slice(&[8, 6, 0, 0, 0]);
        let mut output = b"\x89PNG\r\n\x1a\n".to_vec();
        Self::append_chunk(&mut output, b"IHDR", &header)?;
        Self::append_chunk(&mut output, b"IDAT", &compressed)?;
        Self::append_chunk(&mut output, b"IEND", &[])?;
        Ok(output)
    }

    fn append_chunk(output: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) -> Result<(), CompareError> {
        let length = u32::try_from(data.len())
            .ok()
            .filter(|value| *value <= 0x7fff_ffff)
            .ok_or_else(|| {
                CompareError::ResourceLimit("PNG chunk exceeds the format limit".into())
            })?;
        output.try_reserve(data.len() + 12).map_err(|error| {
            CompareError::ResourceLimit(format!("PNG output allocation failed: {error}"))
        })?;
        let mut checksum = crc32fast::Hasher::new();
        checksum.update(kind);
        checksum.update(data);
        output.extend_from_slice(&length.to_be_bytes());
        output.extend_from_slice(kind);
        output.extend_from_slice(data);
        output.extend_from_slice(&checksum.finalize().to_be_bytes());
        Ok(())
    }
}

struct PngHeader {
    width: u32,
    height: u32,
    channels: usize,
    row_bytes: usize,
    stride: usize,
    filtered_bytes: usize,
    rgba_bytes: usize,
}

impl PngHeader {
    fn parse(data: &[u8], limits: &ImageLimits) -> Result<Self, CompareError> {
        if data.len() != 13 {
            return Err(CompareError::Codec("PNG IHDR must contain 13 bytes".into()));
        }
        if data[8] != 8 || ![2, 6].contains(&data[9]) {
            return Err(CompareError::Codec(
                "Only 8-bit RGB and RGBA PNG images are supported".into(),
            ));
        }
        if data[10] != 0 || data[11] != 0 {
            return Err(CompareError::Codec(
                "Unsupported PNG compression or filter method".into(),
            ));
        }
        if data[12] != 0 {
            return Err(CompareError::Codec(
                "Interlaced PNG images are unsupported".into(),
            ));
        }
        let width = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        let height = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        if width > 0x7fff_ffff || height > 0x7fff_ffff {
            return Err(CompareError::InvalidImage(
                "PNG dimensions exceed the format limit".into(),
            ));
        }
        let rgba_bytes = RgbaImage::required_bytes(width, height)?;
        if rgba_bytes / 4 > limits.max_pixels {
            return Err(CompareError::ResourceLimit(
                "PNG decoded pixel budget exceeded".into(),
            ));
        }
        let channels = if data[9] == 6 { 4 } else { 3 };
        let row_bytes = (width as usize)
            .checked_mul(channels)
            .ok_or_else(|| CompareError::ResourceLimit("PNG row size overflow".into()))?;
        let stride = row_bytes
            .checked_add(1)
            .ok_or_else(|| CompareError::ResourceLimit("PNG scanline size overflow".into()))?;
        let filtered_bytes = stride.checked_mul(height as usize).ok_or_else(|| {
            CompareError::ResourceLimit("PNG scanline buffer size overflow".into())
        })?;
        Ok(Self {
            width,
            height,
            channels,
            row_bytes,
            stride,
            filtered_bytes,
            rgba_bytes,
        })
    }

    fn inflate(&self, compressed: &[u8]) -> Result<RgbaImage, CompareError> {
        // One sentinel byte distinguishes oversized expansion from an exact scanline payload.
        let capacity = self
            .filtered_bytes
            .checked_add(1)
            .ok_or_else(|| CompareError::ResourceLimit("PNG decompression size overflow".into()))?;
        let mut rows = Vec::new();
        rows.try_reserve_exact(capacity).map_err(|error| {
            CompareError::ResourceLimit(format!("PNG scanline allocation failed: {error}"))
        })?;
        rows.resize(capacity, 0);
        let mut decoder = Decompress::new(true);
        let status = decoder
            .decompress(compressed, &mut rows, FlushDecompress::Finish)
            .map_err(|error| CompareError::Codec(format!("Invalid PNG image data: {error}")))?;
        if decoder.total_out() > self.filtered_bytes as u64 {
            return Err(CompareError::ResourceLimit(
                "PNG decompression budget exceeded".into(),
            ));
        }
        if status != Status::StreamEnd || decoder.total_out() != self.filtered_bytes as u64 {
            return Err(CompareError::Codec(
                "PNG decompressed length does not match its dimensions".into(),
            ));
        }
        if decoder.total_in() != compressed.len() as u64 {
            return Err(CompareError::Codec(
                "PNG IDAT contains trailing compressed data".into(),
            ));
        }
        rows.truncate(self.filtered_bytes);
        self.unfilter(&mut rows)?;
        let mut pixels = Vec::new();
        pixels.try_reserve_exact(self.rgba_bytes).map_err(|error| {
            CompareError::ResourceLimit(format!("PNG RGBA allocation failed: {error}"))
        })?;
        for row in rows.chunks_exact(self.stride) {
            for pixel in row[1..].chunks_exact(self.channels) {
                pixels.extend_from_slice(pixel);
                if self.channels == 3 {
                    pixels.push(255);
                }
            }
        }
        RgbaImage::new(self.width, self.height, pixels)
    }

    fn unfilter(&self, rows: &mut [u8]) -> Result<(), CompareError> {
        for y in 0..self.height as usize {
            let start = y * self.stride + 1;
            let filter = rows[start - 1];
            if filter > 4 {
                return Err(CompareError::Codec(format!(
                    "Unsupported PNG row filter {filter}"
                )));
            }
            for x in 0..self.row_bytes {
                let offset = start + x;
                let left = if x >= self.channels {
                    rows[offset - self.channels]
                } else {
                    0
                };
                let above = if y > 0 { rows[offset - self.stride] } else { 0 };
                let diagonal = if y > 0 && x >= self.channels {
                    rows[offset - self.stride - self.channels]
                } else {
                    0
                };
                let predictor = match filter {
                    0 => 0,
                    1 => left,
                    2 => above,
                    3 => ((u16::from(left) + u16::from(above)) / 2) as u8,
                    _ => {
                        let estimate = i16::from(left) + i16::from(above) - i16::from(diagonal);
                        let distance_left = (estimate - i16::from(left)).abs();
                        let distance_above = (estimate - i16::from(above)).abs();
                        let distance_diagonal = (estimate - i16::from(diagonal)).abs();
                        if distance_left <= distance_above && distance_left <= distance_diagonal {
                            left
                        } else if distance_above <= distance_diagonal {
                            above
                        } else {
                            diagonal
                        }
                    }
                };
                rows[offset] = rows[offset].wrapping_add(predictor);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "png_tests.rs"]
mod tests;

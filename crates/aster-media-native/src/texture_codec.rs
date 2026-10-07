use std::io::Cursor;

use crate::MediaError;

pub(crate) struct TextureCodec;

impl TextureCodec {
    pub fn jpeg(bytes: &[u8], size: (u32, u32)) -> Result<Vec<u8>, MediaError> {
        #[cfg(windows)]
        {
            crate::jpeg_windows::WindowsJpeg::decode(bytes, size)
        }
        #[cfg(not(windows))]
        {
            let _ = (bytes, size);
            Err(MediaError::Unsupported(
                "native JPEG normal decoder unavailable on this platform".into(),
            ))
        }
    }

    pub fn webp(bytes: &[u8], size: (u32, u32), budget: u64) -> Result<Vec<u8>, MediaError> {
        let error = |error: image_webp::DecodingError| {
            MediaError::Unsupported(format!("WebP decode: {error}"))
        };
        let mut decoder = image_webp::WebPDecoder::new(Cursor::new(bytes)).map_err(error)?;
        decoder.set_memory_limit(
            usize::try_from(budget)
                .map_err(|_| MediaError::Limit("WebP scratch budget overflow".into()))?,
        );
        if decoder.dimensions() != size {
            return Err(MediaError::Identity);
        }
        if decoder.is_animated() {
            return Self::webp_first_frame(bytes, size, budget);
        }
        let components = if decoder.has_alpha() { 4 } else { 3 };
        let length = size.0 as usize * size.1 as usize * components;
        if decoder.output_buffer_size() != Some(length) {
            return Err(MediaError::Identity);
        }
        let mut data = vec![0; length];
        // Static images and extracted first subframes share the same pixel decoder.
        decoder.read_image(&mut data).map_err(error)?;
        if components == 3 {
            let mut rgba = Vec::with_capacity(size.0 as usize * size.1 as usize * 4);
            for pixel in data.chunks_exact(3) {
                rgba.extend_from_slice(pixel);
                rgba.push(255);
            }
            Ok(rgba)
        } else {
            Ok(data)
        }
    }

    fn webp_first_frame(
        bytes: &[u8],
        size: (u32, u32),
        budget: u64,
    ) -> Result<Vec<u8>, MediaError> {
        let mut offset: usize = 12;
        while offset < bytes.len() {
            let header = bytes.get(offset..offset + 8).ok_or(MediaError::Identity)?;
            let count =
                u32::from_le_bytes(header[4..8].try_into().map_err(|_| MediaError::Identity)?)
                    as usize;
            let end = offset
                .checked_add(8)
                .and_then(|n| n.checked_add(count))
                .ok_or(MediaError::Identity)?;
            let data = bytes.get(offset + 8..end).ok_or(MediaError::Identity)?;
            if &header[..4] == b"ANMF" {
                let frame = data.get(..16).ok_or(MediaError::Identity)?;
                let u24 = |start: usize| {
                    u32::from_le_bytes([frame[start], frame[start + 1], frame[start + 2], 0])
                };
                let (x, y, width, height) = (u24(0) * 2, u24(3) * 2, u24(6) + 1, u24(9) + 1);
                if x + width > size.0 || y + height > size.1 {
                    return Err(MediaError::Identity);
                }
                let payload = data.get(16..).ok_or(MediaError::Identity)?;
                let mut still = b"RIFF\0\0\0\0WEBP".to_vec();
                if payload.starts_with(b"ALPH") {
                    still.extend_from_slice(b"VP8X\x0a\0\0\0\x10\0\0\0");
                    still.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
                    still.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
                }
                still.extend_from_slice(payload);
                let length = u32::try_from(still.len() - 8).map_err(|_| MediaError::Identity)?;
                still[4..8].copy_from_slice(&length.to_le_bytes());
                let decoded = Self::webp(&still, (width, height), budget)?;
                let mut canvas = vec![0; size.0 as usize * size.1 as usize * 4];
                // The first frame is copied onto a transparent canvas. Avoid the codec's
                // animated source-over rounding, which subtracts one from opaque colors.
                for row in 0..height as usize {
                    let from = row * width as usize * 4;
                    let to = ((y as usize + row) * size.0 as usize + x as usize) * 4;
                    canvas[to..to + width as usize * 4]
                        .copy_from_slice(&decoded[from..from + width as usize * 4]);
                }
                return Ok(canvas);
            }
            offset = end.checked_add(count & 1).ok_or(MediaError::Identity)?;
        }
        Err(MediaError::Identity)
    }
}

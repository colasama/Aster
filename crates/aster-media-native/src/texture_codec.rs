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
        if decoder.dimensions() != size || decoder.is_animated() {
            return Err(MediaError::Identity);
        }
        let components = if decoder.has_alpha() { 4 } else { 3 };
        let length = size.0 as usize * size.1 as usize * components;
        if decoder.output_buffer_size() != Some(length) {
            return Err(MediaError::Identity);
        }
        let mut data = vec![0; length];
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
}

use std::io::Cursor;

use skrifa::bitmap::{BitmapData, BitmapGlyph, Origin};

use crate::{
    GlyphImage, GlyphImageFormat, GlyphRasterConfig, GlyphRasterError, GlyphRasterRequest,
};

pub(crate) struct BitmapRaster;

impl BitmapRaster {
    pub(crate) fn render(
        bitmap: &BitmapGlyph<'_>,
        upem: u16,
        request: &GlyphRasterRequest,
        config: &GlyphRasterConfig,
        image: &mut GlyphImage,
    ) -> Result<(), GlyphRasterError> {
        if let Some(reason) = request.paint.unsupported(true, false) {
            return Err(GlyphRasterError::Unsupported(reason));
        }
        if bitmap.ppem_x <= 0.0
            || bitmap.ppem_y <= 0.0
            || upem == 0
            || [
                bitmap.ppem_x,
                bitmap.ppem_y,
                bitmap.bearing_x,
                bitmap.bearing_y,
                bitmap.inner_bearing_x,
                bitmap.inner_bearing_y,
            ]
            .iter()
            .any(|v| !v.is_finite())
        {
            return Err(GlyphRasterError::Invalid("bitmap placement metrics"));
        }
        if bitmap.width == 0 || bitmap.height == 0 {
            return Err(GlyphRasterError::Invalid("empty embedded bitmap"));
        }
        let (format, pixels) = Self::decode(bitmap, config)?;
        let scale = [request.size / bitmap.ppem_x, request.size / bitmap.ppem_y];
        let width = bitmap.width as f32 * scale[0];
        let height = bitmap.height as f32 * scale[1];
        let left = bitmap.bearing_x * request.size / upem as f32
            + bitmap.inner_bearing_x * scale[0]
            + request.phase[0];
        let top = -(bitmap.bearing_y * request.size / upem as f32
            + bitmap.inner_bearing_y * scale[1])
            - if bitmap.placement_origin == Origin::BottomLeft {
                height
            } else {
                0.0
            }
            + request.phase[1];
        if [left, top, width, height]
            .iter()
            .any(|v| !v.is_finite() || v.abs() > 1_048_576.0)
        {
            return Err(GlyphRasterError::Limit("scaled bitmap placement"));
        }
        let origin = [left.floor() as i32, top.floor() as i32];
        let dimensions = [
            ((left + width).ceil() - origin[0] as f32) as u32,
            ((top + height).ceil() - origin[1] as f32) as u32,
        ];
        let channels = format.channels();
        let bytes = config.image_bytes(dimensions[0], dimensions[1], channels)?;
        let mut output = vec![0; bytes];
        // Resample premultiplied color to avoid transparent-edge color fringes.
        for y in 0..dimensions[1] {
            for x in 0..dimensions[0] {
                let sx = (origin[0] as f32 + x as f32 + 0.5 - left) / scale[0] - 0.5;
                let sy = (origin[1] as f32 + y as f32 + 0.5 - top) / scale[1] - 0.5;
                let ix = sx.floor() as i64;
                let iy = sy.floor() as i64;
                let fx = sx - sx.floor();
                let fy = sy - sy.floor();
                for channel in 0..channels {
                    let mut value = 0.0;
                    for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
                        for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
                            let px = ix + dx;
                            let py = iy + dy;
                            if px >= 0
                                && py >= 0
                                && px < i64::from(bitmap.width)
                                && py < i64::from(bitmap.height)
                            {
                                value += pixels[(py as usize * bitmap.width as usize + px as usize)
                                    * channels
                                    + channel] as f32
                                    * wx
                                    * wy;
                            }
                        }
                    }
                    output
                        [(y as usize * dimensions[0] as usize + x as usize) * channels + channel] =
                        value.round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        image.format = format;
        image.width = dimensions[0];
        image.height = dimensions[1];
        image.origin = origin;
        image.data = output;
        Ok(())
    }

    fn decode(
        bitmap: &BitmapGlyph<'_>,
        config: &GlyphRasterConfig,
    ) -> Result<(GlyphImageFormat, Vec<u8>), GlyphRasterError> {
        match &bitmap.data {
            BitmapData::Mask(mask) => {
                let mut output = vec![0; config.image_bytes(bitmap.width, bitmap.height, 1)?];
                mask.decode_to_slice(bitmap.width, bitmap.height, &mut output)
                    .map_err(|_| GlyphRasterError::Invalid("embedded mask bytes"))?;
                Ok((GlyphImageFormat::Coverage, output))
            }
            BitmapData::Bgra(bytes) => {
                let length = config.image_bytes(bitmap.width, bitmap.height, 4)?;
                if bytes.len() != length {
                    return Err(GlyphRasterError::Invalid("embedded BGRA bytes"));
                }
                let mut output = bytes.to_vec();
                for pixel in output.chunks_exact_mut(4) {
                    pixel.swap(0, 2);
                }
                Ok((GlyphImageFormat::PremultipliedSrgbRgba, output))
            }
            BitmapData::Png(bytes) => Self::png(bytes, bitmap.width, bitmap.height, config),
        }
    }

    fn png(
        bytes: &[u8],
        width: u32,
        height: u32,
        config: &GlyphRasterConfig,
    ) -> Result<(GlyphImageFormat, Vec<u8>), GlyphRasterError> {
        let length = config.image_bytes(width, height, 4)?;
        if bytes.len() > config.max_glyph_bytes {
            return Err(GlyphRasterError::Limit("compressed glyph PNG"));
        }
        let mut decoder = png::Decoder::new_with_limits(
            Cursor::new(bytes),
            png::Limits {
                bytes: config.max_glyph_bytes,
            },
        );
        decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
        let mut reader = decoder.read_info()?;
        if reader.info().width != width
            || reader.info().height != height
            || reader.info().animation_control.is_some()
        {
            return Err(GlyphRasterError::Invalid(
                "embedded PNG dimensions or animation",
            ));
        }
        let decoded = reader
            .output_buffer_size()
            .filter(|n| *n <= length)
            .ok_or(GlyphRasterError::Limit("decoded glyph PNG"))?;
        let mut pixels = vec![0; decoded];
        let info = reader.next_frame(&mut pixels)?;
        if info.bit_depth != png::BitDepth::Eight || info.width != width || info.height != height {
            return Err(GlyphRasterError::Invalid("decoded PNG format"));
        }
        let channels = match info.color_type {
            png::ColorType::Grayscale => 1,
            png::ColorType::GrayscaleAlpha => 2,
            png::ColorType::Rgb => 3,
            png::ColorType::Rgba => 4,
            _ => return Err(GlyphRasterError::Invalid("unexpanded PNG palette")),
        };
        if info.buffer_size() != width as usize * height as usize * channels {
            return Err(GlyphRasterError::Invalid("decoded PNG byte count"));
        }
        let mut output = Vec::with_capacity(length);
        for pixel in pixels[..info.buffer_size()].chunks_exact(channels) {
            let (rgb, alpha) = match channels {
                1 => ([pixel[0]; 3], 255),
                2 => ([pixel[0]; 3], pixel[1]),
                3 => ([pixel[0], pixel[1], pixel[2]], 255),
                _ => ([pixel[0], pixel[1], pixel[2]], pixel[3]),
            };
            output.extend(rgb.map(|c| ((u16::from(c) * u16::from(alpha) + 127) / 255) as u8));
            output.push(alpha);
        }
        Ok((GlyphImageFormat::PremultipliedSrgbRgba, output))
    }
}

use crate::MediaError;
use aster_render_ir::{
    ResourceDescriptor, ResourceKind, TextureDimension, TexturePixelFormat,
    TexturePixelsDescriptor, VerifiedResource,
};
use aster_video::CancellationToken;
use std::time::Instant;

#[derive(Clone, Debug, clap::Args)]
pub struct RadianceLimits {
    #[arg(long, default_value_t = 50_331_648)]
    pub radiance_source_bytes: usize,
    #[arg(long, default_value_t = 8192)]
    pub radiance_width: u32,
    #[arg(long, default_value_t = 4096)]
    pub radiance_height: u32,
    #[arg(long, default_value_t = 16_777_216)]
    pub radiance_pixels: u64,
    #[arg(long, default_value_t = 30_000)]
    pub radiance_timeout_ms: u64,
}

/// Bounded Radiance RGBE input; output preserves the retained binary16 conversion exactly.
pub struct RadianceEnvironment {
    bytes: Vec<u8>,
    offset: usize,
}
impl RadianceEnvironment {
    pub fn decode(
        bytes: Vec<u8>,
        limits: &RadianceLimits,
        cancellation: &CancellationToken,
    ) -> Result<VerifiedResource, MediaError> {
        if !(1..=50_331_648).contains(&limits.radiance_source_bytes)
            || !(1..=8192).contains(&limits.radiance_width)
            || !(1..=4096).contains(&limits.radiance_height)
            || !(1..=16_777_216).contains(&limits.radiance_pixels)
            || limits.radiance_timeout_ms == 0
            || bytes.is_empty()
            || bytes.len() > limits.radiance_source_bytes
        {
            return Err(MediaError::Limit(
                "bounded Radiance source and output limits required".into(),
            ));
        }
        let started = Instant::now();
        let mut input = Self { bytes, offset: 0 };
        if !["#?RADIANCE", "#?RGBE"].contains(&input.line()?.as_str()) {
            return Err(MediaError::Unsupported("invalid Radiance signature".into()));
        }
        let mut format = false;
        while input.offset < input.bytes.len() {
            let line = input.line()?;
            if line.is_empty() {
                break;
            }
            format |= line == "FORMAT=32-bit_rle_rgbe";
        }
        if !format {
            return Err(MediaError::Unsupported(
                "Radiance requires 32-bit_rle_rgbe".into(),
            ));
        }
        let line = input.line()?;
        let parts = line.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 4
            || parts[0] != "-Y"
            || parts[2] != "+X"
            || !parts[1].bytes().all(|b| b.is_ascii_digit())
            || !parts[3].bytes().all(|b| b.is_ascii_digit())
        {
            return Err(MediaError::Unsupported(
                "Radiance orientation must be -Y +X".into(),
            ));
        }
        let width = parts[3]
            .parse::<u32>()
            .map_err(|_| MediaError::Limit("Radiance width".into()))?;
        let height = parts[1]
            .parse::<u32>()
            .map_err(|_| MediaError::Limit("Radiance height".into()))?;
        if width == 0
            || height == 0
            || width > limits.radiance_width
            || height > limits.radiance_height
            || u64::from(width) * u64::from(height) > limits.radiance_pixels
        {
            return Err(MediaError::Limit(
                "Radiance dimensions exceed budget".into(),
            ));
        }
        let mut pixels = vec![0_u8; width as usize * height as usize * 8];
        let mut scanline = vec![0_u8; width as usize * 4];
        let mut channels = vec![0_u8; width as usize * 4];
        for y in 0..height as usize {
            if cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            if started.elapsed().as_millis() > u128::from(limits.radiance_timeout_ms) {
                return Err(MediaError::Limit(
                    "Radiance decode deadline exceeded".into(),
                ));
            }
            input.scanline(width as usize, &mut scanline, &mut channels)?;
            for (x, pixel) in scanline.chunks_exact(4).enumerate() {
                let scale = if pixel[3] == 0 {
                    0.0
                } else {
                    2_f64.powi(i32::from(pixel[3]) - 136)
                };
                let half = [
                    Self::half(f64::from(pixel[0]) * scale),
                    Self::half(f64::from(pixel[1]) * scale),
                    Self::half(f64::from(pixel[2]) * scale),
                    0x3c00,
                ];
                for (channel, value) in half.into_iter().enumerate() {
                    let offset = (y * width as usize + x) * 8 + channel * 2;
                    pixels[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
                }
            }
        }
        if input.offset != input.bytes.len() {
            return Err(MediaError::Unsupported("Radiance trailing data".into()));
        }
        Ok(VerifiedResource::new(
            ResourceKind::TexturePixels,
            ResourceDescriptor::TexturePixels(TexturePixelsDescriptor {
                dimension: TextureDimension::D2,
                width,
                height,
                depth: 1,
                format: TexturePixelFormat::Rgba16Float,
            }),
            pixels,
        )?)
    }

    fn line(&mut self) -> Result<String, MediaError> {
        let start = self.offset;
        while self.offset < self.bytes.len() && self.bytes[self.offset] != b'\n' {
            self.offset += 1;
            if self.offset - start > 4096 {
                return Err(MediaError::Limit("Radiance header line too long".into()));
            }
        }
        if self.offset == self.bytes.len() {
            return Err(MediaError::Unsupported("truncated Radiance header".into()));
        }
        let end = if self.offset > start && self.bytes[self.offset - 1] == b'\r' {
            self.offset - 1
        } else {
            self.offset
        };
        self.offset += 1;
        Ok(self.bytes[start..end]
            .iter()
            .map(|b| char::from(*b))
            .collect())
    }

    fn byte(&mut self) -> Result<u8, MediaError> {
        let value = self
            .bytes
            .get(self.offset)
            .copied()
            .ok_or_else(|| MediaError::Unsupported("truncated Radiance scanline".into()))?;
        self.offset += 1;
        Ok(value)
    }

    fn scanline(
        &mut self,
        width: usize,
        output: &mut [u8],
        channels: &mut [u8],
    ) -> Result<(), MediaError> {
        let prefix = self.bytes.get(self.offset..self.offset + 4);
        let rle = (8..=0x7fff).contains(&width)
            && prefix.is_some_and(|p| {
                p[0] == 2
                    && p[1] == 2
                    && p[2] & 0x80 == 0
                    && (usize::from(p[2]) << 8) + usize::from(p[3]) == width
            });
        if !rle {
            let end = self.offset + width * 4;
            let source = self
                .bytes
                .get(self.offset..end)
                .ok_or_else(|| MediaError::Unsupported("truncated Radiance scanline".into()))?;
            output.copy_from_slice(source);
            self.offset = end;
            return Ok(());
        }
        self.offset += 4;
        for channel in 0..4 {
            let mut written = 0;
            while written < width {
                let count = usize::from(self.byte()?);
                let length = if count > 128 { count - 128 } else { count };
                if length == 0 || written + length > width {
                    return Err(MediaError::Unsupported("invalid Radiance RLE run".into()));
                }
                if count > 128 {
                    let value = self.byte()?;
                    channels[channel * width + written..channel * width + written + length]
                        .fill(value);
                } else {
                    for index in 0..length {
                        channels[channel * width + written + index] = self.byte()?;
                    }
                }
                written += length;
            }
        }
        for x in 0..width {
            for channel in 0..4 {
                output[x * 4 + channel] = channels[channel * width + x];
            }
        }
        Ok(())
    }

    fn half(value: f64) -> u16 {
        let bits = (value.clamp(-65504.0, 65504.0) as f32).to_bits();
        let sign = (bits >> 16) & 0x8000;
        let mut exponent = ((bits >> 23) & 0xff) as i32 - 112;
        let mut mantissa = bits & 0x7fffff;
        if exponent <= 0 {
            if exponent < -10 {
                return sign as u16;
            }
            mantissa = (mantissa | 0x800000) >> (1 - exponent);
            return (sign | ((mantissa + 0x1000) >> 13)) as u16;
        }
        if exponent >= 31 {
            return (sign | 0x7bff) as u16;
        }
        mantissa += 0x1000;
        if mantissa & 0x800000 != 0 {
            mantissa = 0;
            exponent += 1;
            if exponent >= 31 {
                return (sign | 0x7bff) as u16;
            }
        }
        (sign | ((exponent as u32) << 10) | (mantissa >> 13)) as u16
    }
}

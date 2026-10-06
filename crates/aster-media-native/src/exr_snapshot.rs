use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::time::{Duration, Instant};

use aster_render_ir::MediaFrameDescriptor;
use aster_video::CancellationToken;
use exr::prelude::{ReadChannels, ReadLayers, RgbaChannels, SampleType, Vec2, f16, read};

use crate::{MediaError, StillLimits};

/// Owned, seekable snapshot with cooperative cancellation at every decoder read.
pub(crate) struct ExrSnapshot {
    input: Cursor<Vec<u8>>,
    cancellation: CancellationToken,
    started: Instant,
    timeout: Duration,
}

struct LinearPixels {
    bytes: Vec<u8>,
    width: usize,
    invalid: bool,
}

impl LinearPixels {
    fn create(size: Vec2<usize>, _: &RgbaChannels) -> Self {
        Self {
            bytes: vec![0; size.area() * 8],
            width: size.width(),
            invalid: false,
        }
    }

    fn set(&mut self, position: Vec2<usize>, rgba: (f32, f32, f32, f32)) {
        let (r, g, b, alpha) = rgba;
        if ![r, g, b, alpha].iter().all(|value| value.is_finite()) || !(0.0..=1.0).contains(&alpha)
        {
            self.invalid = true;
            return;
        }
        // EXR stores associated linear RGB; the shared image shader expects straight samples.
        let unassociate = |value| if alpha > 0.0 { value / alpha } else { 0.0 };
        let samples = [unassociate(r), unassociate(g), unassociate(b), alpha].map(f16::from_f32);
        if samples.iter().any(|value| !value.is_finite()) {
            self.invalid = true;
            return;
        }
        let offset = (position.y() * self.width + position.x()) * 8;
        let Some(destination) = self.bytes.get_mut(offset..offset + 8) else {
            self.invalid = true;
            return;
        };
        for (sample, target) in samples.into_iter().zip(destination.chunks_exact_mut(2)) {
            target.copy_from_slice(&sample.to_bits().to_le_bytes());
        }
    }
}

impl ExrSnapshot {
    pub(crate) fn decode(
        encoded: Vec<u8>,
        frame: &MediaFrameDescriptor,
        limits: &StillLimits,
        cancellation: &CancellationToken,
    ) -> Result<Vec<u8>, MediaError> {
        Self::preflight(&encoded, frame, limits)?;
        let reader = Self {
            input: Cursor::new(encoded),
            cancellation: cancellation.clone(),
            started: Instant::now(),
            timeout: Duration::from_millis(limits.still_timeout_ms),
        };
        let started = reader.started;
        let image = read()
            .no_deep_data()
            .largest_resolution_level()
            .rgba_channels(LinearPixels::create, LinearPixels::set)
            .first_valid_layer()
            .all_attributes()
            .non_parallel()
            .pedantic()
            .from_buffered(reader)
            .map_err(|error| MediaError::Exr(error.to_string()))?;
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if started.elapsed() >= Duration::from_millis(limits.still_timeout_ms) {
            return Err(aster_video::FfmpegError::TimedOut {
                timeout_ms: limits.still_timeout_ms,
            }
            .into());
        }
        let pixels = image.layer_data.channel_data.pixels;
        if pixels.invalid {
            return Err(MediaError::Exr(
                "non-finite or unrepresentable linear RGBA samples".into(),
            ));
        }
        Ok(pixels.bytes)
    }

    fn preflight(
        encoded: &[u8],
        frame: &MediaFrameDescriptor,
        limits: &StillLimits,
    ) -> Result<(), MediaError> {
        if encoded.len() < 8
            || encoded[..4] != [0x76, 0x2f, 0x31, 0x01]
            || u32::from_le_bytes([encoded[4], encoded[5], encoded[6], encoded[7]]) & !0x200 != 2
        {
            return Err(MediaError::Unsupported(
                "EXR must be a single flat layer".into(),
            ));
        }
        // Bound attribute lengths before the format library allocates metadata collections.
        let bound = encoded.len().min(limits.still_max_header_bytes);
        let mut offset = 8;
        loop {
            if offset >= bound {
                return Err(MediaError::Limit("EXR header exceeds byte budget".into()));
            }
            if encoded[offset] == 0 {
                break;
            }
            for _ in 0..2 {
                let end = encoded[offset..bound]
                    .iter()
                    .position(|byte| *byte == 0)
                    .ok_or_else(|| MediaError::Exr("unterminated EXR attribute".into()))?;
                if end > 255 {
                    return Err(MediaError::Limit("EXR attribute name exceeds bound".into()));
                }
                offset += end + 1;
            }
            let length = encoded
                .get(offset..offset + 4)
                .filter(|_| offset + 4 <= bound)
                .ok_or_else(|| MediaError::Exr("truncated EXR attribute size".into()))?;
            let length = u32::from_le_bytes([length[0], length[1], length[2], length[3]]) as usize;
            offset = offset
                .checked_add(4)
                .and_then(|offset| offset.checked_add(length))
                .filter(|offset| *offset < bound)
                .ok_or_else(|| MediaError::Limit("EXR attributes exceed byte budget".into()))?;
        }
        let metadata = exr::meta::MetaData::read_from_buffered(&encoded[..offset + 1], true)
            .map_err(|error| MediaError::Exr(error.to_string()))?;
        let [header] = metadata.headers.as_slice() else {
            return Err(MediaError::Unsupported("EXR must contain one layer".into()));
        };
        if header.chunk_count > encoded.len() / 8 {
            return Err(MediaError::Limit(
                "EXR offset table exceeds source bytes".into(),
            ));
        }
        if header.deep
            || header.layer_size != Vec2(frame.width as usize, frame.height as usize)
            || header.own_attributes.layer_position != Vec2(0, 0)
            || header.shared_attributes.display_window.position != Vec2(0, 0)
            || header.shared_attributes.display_window.size != header.layer_size
        {
            return Err(MediaError::Unsupported(
                "EXR extent or display window differs from the frame".into(),
            ));
        }
        let channels = &header.channels.list;
        if !(3..=4).contains(&channels.len())
            || channels.iter().any(|channel| {
                !["R", "G", "B", "A"]
                    .iter()
                    .any(|name| channel.name == **name)
                    || channel.sampling != Vec2(1, 1)
                    || channel.sample_type == SampleType::U32
            })
            || ["R", "G", "B"]
                .iter()
                .any(|name| !channels.iter().any(|channel| channel.name == **name))
        {
            return Err(MediaError::Unsupported(
                "EXR requires full-resolution float RGB with optional alpha".into(),
            ));
        }
        if let Some(c) = header.shared_attributes.chromaticities {
            for (actual, expected) in [
                (c.red, Vec2(0.64, 0.33)),
                (c.green, Vec2(0.30, 0.60)),
                (c.blue, Vec2(0.15, 0.06)),
                (c.white, Vec2(0.3127, 0.3290)),
            ] {
                if (actual.x() - expected.x()).abs() > 0.0001
                    || (actual.y() - expected.y()).abs() > 0.0001
                    || !actual.x().is_finite()
                    || !actual.y().is_finite()
                {
                    return Err(MediaError::Unsupported(
                        "EXR chromaticities require a color transform".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn check(&self) -> io::Result<()> {
        if self.cancellation.is_cancelled() || self.started.elapsed() >= self.timeout {
            return Err(io::Error::other("EXR decode cancelled or timed out"));
        }
        Ok(())
    }
}

impl Read for ExrSnapshot {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.check()?;
        self.input.read(output)
    }
}

impl Seek for ExrSnapshot {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.check()?;
        self.input.seek(position)
    }
}

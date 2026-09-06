//! Bounded OpenEXR export for linear-light RGBA frames.
//!
//! RGB samples use linear BT.709/sRGB primaries with a D65 white point and are
//! already associated (premultiplied) by alpha. Alpha is coverage in `[0, 1]`.
//! Samples are stored as provided; this backend does not color transform,
//! premultiply, or unpremultiply them.

use aster_storage::AtomicFile;
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use exr::meta::attribute::Chromaticities;
use exr::prelude::{
    AttributeValue, Encoding, Image, Layer, LayerAttributes, SpecificChannels, Text, Vec2,
    WritableImage, f16,
};
use thiserror::Error;

use crate::CancellationToken;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrPrecision {
    F16,
    F32,
}

impl ExrPrecision {
    const ZIP_SCAN_LINES: u64 = 16;
    fn bytes_per_pixel(self) -> u64 {
        match self {
            Self::F16 => 8,
            Self::F32 => 16,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExrFrame {
    pub width: u32,
    pub height: u32,
    /// Row-major, associated-alpha (premultiplied) linear RGBA pixels.
    pub pixels: Arc<[[f32; 4]]>,
}

#[derive(Debug, Clone)]
pub struct ExrWriteRequest {
    pub output_path: PathBuf,
    pub precision: ExrPrecision,
    pub frame: ExrFrame,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExrSequenceRequest {
    pub directory: PathBuf,
    pub file_stem: String,
    pub frame_index: u64,
    pub zero_padding: u8,
    pub precision: ExrPrecision,
}

#[derive(Debug, Clone, clap::Args)]
pub struct ExrLimits {
    #[arg(long = "exr-max-path-units", default_value_t = Self::default().max_path_units)]
    pub max_path_units: usize,
    #[arg(long = "exr-max-sequence-stem-bytes", default_value_t = Self::default().max_sequence_stem_bytes)]
    pub max_sequence_stem_bytes: usize,
    #[arg(long = "exr-max-sequence-padding", default_value_t = Self::default().max_sequence_padding)]
    pub max_sequence_padding: u8,
    #[arg(long = "exr-max-sequence-index", default_value_t = Self::default().max_sequence_index)]
    pub max_sequence_index: u64,
    #[arg(long = "exr-max-width", default_value_t = Self::default().max_width)]
    pub max_width: u32,
    #[arg(long = "exr-max-height", default_value_t = Self::default().max_height)]
    pub max_height: u32,
    #[arg(long = "exr-max-pixels", default_value_t = Self::default().max_pixels)]
    pub max_pixels: u64,
    #[arg(long = "exr-max-input-bytes", default_value_t = Self::default().max_input_bytes)]
    pub max_input_bytes: u64,
    #[arg(long = "exr-max-block-bytes", default_value_t = Self::default().max_block_bytes)]
    pub max_block_bytes: u64,
    #[arg(long = "exr-max-output-bytes", default_value_t = Self::default().max_output_bytes)]
    pub max_output_bytes: u64,
}

impl Default for ExrLimits {
    fn default() -> Self {
        Self {
            max_path_units: 32_767,
            max_sequence_stem_bytes: 64,
            max_sequence_padding: 12,
            max_sequence_index: 999_999_999_999,
            max_width: 8_192,
            max_height: 8_192,
            max_pixels: 67_108_864,
            max_input_bytes: 1024 * 1024 * 1024,
            max_block_bytes: 16 * 1024 * 1024,
            max_output_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExrWriteReport {
    pub output_path: PathBuf,
    pub width: u32,
    pub height: u32,
    pub precision: ExrPrecision,
    pub bytes_written: u64,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ExrError {
    #[error("invalid OpenEXR request: {0}")]
    InvalidRequest(String),
    #[error("OpenEXR output already exists: {0}")]
    OutputExists(PathBuf),
    #[error("OpenEXR export was cancelled")]
    Cancelled,
    #[error("pixel {pixel_index} channel {channel} is invalid for {precision:?}")]
    InvalidPixel {
        pixel_index: usize,
        channel: &'static str,
        precision: ExrPrecision,
    },
    #[error("OpenEXR output exceeded its {limit} byte limit")]
    OutputTooLarge { limit: u64 },
    #[error("OpenEXR codec failed: {0}")]
    Codec(String),
    #[error("OpenEXR file I/O failed: {0}")]
    Io(String),
    #[error("failed to atomically publish OpenEXR output: {0}")]
    Publish(String),
}

#[derive(Debug, Clone, Default)]
pub struct ExrBackend {
    limits: ExrLimits,
}

impl ExrBackend {
    pub fn with_limits(limits: ExrLimits) -> Self {
        Self { limits }
    }

    pub fn write_frame(
        &self,
        request: &ExrWriteRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExrWriteReport, ExrError> {
        let validated = request.validate(&self.limits, cancellation)?;
        let (temporary, file) = AtomicFile::stage(&request.output_path).map_err(ExrError::from)?;
        let overflowed = Arc::new(AtomicBool::new(false));
        let writer = BoundedCancellableFile {
            file,
            cancellation: cancellation.clone(),
            max_written_bytes: self.limits.max_output_bytes,
            position: 0,
            max_extent: 0,
            overflowed: overflowed.clone(),
        };

        let result = match request.precision {
            ExrPrecision::F16 => request.write_f16(validated, writer),
            ExrPrecision::F32 => request.write_f32(validated, writer),
        };
        if cancellation.is_cancelled() {
            return Err(ExrError::Cancelled);
        }
        if overflowed.load(Ordering::Acquire) {
            return Err(ExrError::OutputTooLarge {
                limit: self.limits.max_output_bytes,
            });
        }
        result.map_err(|error| match error {
            exr::error::Error::Io(error) => ExrError::Io(error.to_string()),
            error => ExrError::Codec(error.to_string()),
        })?;

        let bytes_written = temporary
            .temporary
            .metadata()
            .map_err(|error| ExrError::Io(error.to_string()))?
            .len();
        if bytes_written > self.limits.max_output_bytes {
            return Err(ExrError::OutputTooLarge {
                limit: self.limits.max_output_bytes,
            });
        }
        temporary.publish(false).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                ExrError::OutputExists(request.output_path.clone())
            } else {
                ExrError::Publish(error.to_string())
            }
        })?;
        Ok(ExrWriteReport {
            output_path: request.output_path.clone(),
            width: request.frame.width,
            height: request.frame.height,
            precision: request.precision,
            bytes_written,
        })
    }

    pub fn write_sequence_frame(
        &self,
        sequence: &ExrSequenceRequest,
        frame: ExrFrame,
        cancellation: &CancellationToken,
    ) -> Result<ExrWriteReport, ExrError> {
        let output_path = sequence.output_path(&self.limits)?;
        self.write_frame(
            &ExrWriteRequest {
                output_path,
                precision: sequence.precision,
                frame,
            },
            cancellation,
        )
    }
}

#[derive(Debug, Clone, Copy)]
struct ValidatedExr {
    width: usize,
    height: usize,
}

struct BoundedCancellableFile {
    file: File,
    cancellation: CancellationToken,
    max_written_bytes: u64,
    position: u64,
    max_extent: u64,
    overflowed: Arc<AtomicBool>,
}

impl Write for BoundedCancellableFile {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.cancellation.is_cancelled() {
            return Err(io::Error::other("OpenEXR export cancelled"));
        }
        let next_position = self
            .position
            .checked_add(bytes.len() as u64)
            .filter(|next| *next <= self.max_written_bytes);
        let Some(next_position) = next_position else {
            self.overflowed.store(true, Ordering::Release);
            return Err(io::Error::other("OpenEXR output limit exceeded"));
        };
        let written = self.file.write(bytes)?;
        self.position = self
            .position
            .saturating_add(written as u64)
            .min(next_position);
        self.max_extent = self.max_extent.max(self.position);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.cancellation.is_cancelled() {
            return Err(io::Error::other("OpenEXR export cancelled"));
        }
        self.file.flush()
    }
}

impl Seek for BoundedCancellableFile {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        if self.cancellation.is_cancelled() {
            return Err(io::Error::other("OpenEXR export cancelled"));
        }
        let target = match position {
            SeekFrom::Start(offset) => Some(offset),
            SeekFrom::Current(offset) => self.position.checked_add_signed(offset),
            SeekFrom::End(offset) => self.max_extent.checked_add_signed(offset),
        }
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid OpenEXR seek"))?;
        if target > self.max_written_bytes {
            self.overflowed.store(true, Ordering::Release);
            return Err(io::Error::other("OpenEXR output limit exceeded"));
        }
        self.position = self.file.seek(SeekFrom::Start(target))?;
        Ok(self.position)
    }
}

#[cfg(test)]
#[path = "exr_tests.rs"]
mod tests;

impl ExrWriteRequest {
    fn validate(
        &self,
        limits: &ExrLimits,
        cancellation: &CancellationToken,
    ) -> Result<ValidatedExr, ExrError> {
        self.validate_output_path(limits)?;
        let width = self.frame.width;
        let height = self.frame.height;
        if width == 0 || height == 0 || width > limits.max_width || height > limits.max_height {
            return Err(ExrError::InvalidRequest(
                "dimensions exceed the configured bounds".into(),
            ));
        }
        let pixel_count = u64::from(width)
            .checked_mul(u64::from(height))
            .ok_or_else(|| ExrError::InvalidRequest("pixel count overflowed".into()))?;
        if pixel_count > limits.max_pixels {
            return Err(ExrError::InvalidRequest(
                "pixel count exceeds the configured bound".into(),
            ));
        }
        let expected = usize::try_from(pixel_count)
            .map_err(|_| ExrError::InvalidRequest("pixel count cannot be represented".into()))?;
        if self.frame.pixels.len() != expected {
            return Err(ExrError::InvalidRequest(format!(
                "pixel length was {}; expected {expected}",
                self.frame.pixels.len()
            )));
        }
        let input_bytes = pixel_count
            .checked_mul(16)
            .ok_or_else(|| ExrError::InvalidRequest("input byte count overflowed".into()))?;
        if input_bytes > limits.max_input_bytes {
            return Err(ExrError::InvalidRequest(
                "input memory exceeds the configured bound".into(),
            ));
        }
        let block_bytes = u64::from(width)
            .checked_mul(ExrPrecision::ZIP_SCAN_LINES.min(u64::from(height)))
            .and_then(|samples| samples.checked_mul(self.precision.bytes_per_pixel()))
            .ok_or_else(|| ExrError::InvalidRequest("codec block memory overflowed".into()))?;
        if block_bytes > limits.max_block_bytes {
            return Err(ExrError::InvalidRequest(
                "codec block memory exceeds the configured bound".into(),
            ));
        }
        self.frame.validate_pixels(self.precision, cancellation)?;
        Ok(ValidatedExr {
            width: usize::try_from(width)
                .map_err(|_| ExrError::InvalidRequest("width cannot be represented".into()))?,
            height: usize::try_from(height)
                .map_err(|_| ExrError::InvalidRequest("height cannot be represented".into()))?,
        })
    }
}

impl ExrFrame {
    fn validate_pixels(
        &self,
        precision: ExrPrecision,
        cancellation: &CancellationToken,
    ) -> Result<(), ExrError> {
        let channels = ["R", "G", "B", "A"];
        let half_max = f16::MAX.to_f32();
        for (pixel_index, pixel) in self.pixels.iter().enumerate() {
            if pixel_index.is_multiple_of(4096) && cancellation.is_cancelled() {
                return Err(ExrError::Cancelled);
            }
            for (channel_index, value) in pixel.iter().copied().enumerate() {
                let precision_valid = precision == ExrPrecision::F32 || value.abs() <= half_max;
                let alpha_valid = channel_index != 3 || (0.0..=1.0).contains(&value);
                if !value.is_finite() || !precision_valid || !alpha_valid {
                    return Err(ExrError::InvalidPixel {
                        pixel_index,
                        channel: channels[channel_index],
                        precision,
                    });
                }
            }
        }
        if cancellation.is_cancelled() {
            return Err(ExrError::Cancelled);
        }
        Ok(())
    }
}

impl ExrWriteRequest {
    fn write_f16(
        &self,
        validated: ValidatedExr,
        writer: BoundedCancellableFile,
    ) -> exr::error::UnitResult {
        let pixels = self.frame.pixels.clone();
        let channels = SpecificChannels::rgba(move |Vec2(x, y)| {
            let [r, g, b, a] = pixels[y * validated.width + x];
            (
                f16::from_f32(r),
                f16::from_f32(g),
                f16::from_f32(b),
                f16::from_f32(a),
            )
        });
        let layer = Layer::new(
            (validated.width, validated.height),
            Self::layer_attributes(),
            Encoding::SMALL_LOSSLESS,
            channels,
        );
        let mut image = Image::from_layer(layer);
        Self::decorate_image(&mut image);
        image.write().non_parallel().to_unbuffered(writer)
    }
}

impl ExrWriteRequest {
    fn write_f32(
        &self,
        validated: ValidatedExr,
        writer: BoundedCancellableFile,
    ) -> exr::error::UnitResult {
        let pixels = self.frame.pixels.clone();
        let channels = SpecificChannels::rgba(move |Vec2(x, y)| {
            let [r, g, b, a] = pixels[y * validated.width + x];
            (r, g, b, a)
        });
        let layer = Layer::new(
            (validated.width, validated.height),
            Self::layer_attributes(),
            Encoding::SMALL_LOSSLESS,
            channels,
        );
        let mut image = Image::from_layer(layer);
        Self::decorate_image(&mut image);
        image.write().non_parallel().to_unbuffered(writer)
    }
}

impl ExrWriteRequest {
    fn layer_attributes() -> LayerAttributes {
        let mut attributes = LayerAttributes::named("rgba");
        attributes.software_name = Some(Text::from(concat!("Aster ", env!("CARGO_PKG_VERSION"))));
        attributes.other.insert(
            Text::from("asterAlphaMode"),
            AttributeValue::Text(Text::from("premultiplied_associated")),
        );
        attributes
    }
}

impl ExrWriteRequest {
    fn decorate_image<Layers>(image: &mut Image<Layers>) {
        image.attributes.chromaticities = Some(Chromaticities {
            red: Vec2(0.640, 0.330),
            green: Vec2(0.300, 0.600),
            blue: Vec2(0.150, 0.060),
            white: Vec2(0.3127, 0.3290),
        });
        image.attributes.other.insert(
            Text::from("asterColorEncoding"),
            AttributeValue::Text(Text::from("linear_bt709_d65")),
        );
    }
}

impl ExrSequenceRequest {
    fn output_path(&self, limits: &ExrLimits) -> Result<PathBuf, ExrError> {
        let stem = self.file_stem.as_bytes();
        if stem.is_empty()
            || stem.len() > limits.max_sequence_stem_bytes
            || !stem
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(ExrError::InvalidRequest(
                "sequence stem is not a bounded safe token".into(),
            ));
        }
        if !(1..=limits.max_sequence_padding).contains(&self.zero_padding)
            || self.frame_index > limits.max_sequence_index
        {
            return Err(ExrError::InvalidRequest(
                "sequence frame index or padding exceeds its bound".into(),
            ));
        }
        let index = self.frame_index.to_string();
        if index.len() > usize::from(self.zero_padding) {
            return Err(ExrError::InvalidRequest(
                "sequence frame index exceeds its padding".into(),
            ));
        }
        let metadata = self
            .directory
            .metadata()
            .map_err(|_| ExrError::InvalidRequest("sequence directory does not exist".into()))?;
        if !metadata.is_dir() {
            return Err(ExrError::InvalidRequest(
                "sequence output is not a directory".into(),
            ));
        }
        Ok(self.directory.join(format!(
            "{}.{:0width$}.exr",
            self.file_stem,
            self.frame_index,
            width = usize::from(self.zero_padding)
        )))
    }
}

impl ExrWriteRequest {
    fn validate_output_path(&self, limits: &ExrLimits) -> Result<(), ExrError> {
        let path = &self.output_path;
        if path.as_os_str().is_empty()
            || path.as_os_str().to_string_lossy().encode_utf16().count() > limits.max_path_units
        {
            return Err(ExrError::InvalidRequest(
                "output path is empty or too long".into(),
            ));
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .ok_or_else(|| {
                ExrError::InvalidRequest("output path must have a UTF-8 extension".into())
            })?;
        if !extension.eq_ignore_ascii_case("exr") {
            return Err(ExrError::InvalidRequest(
                "output path must use the .exr extension".into(),
            ));
        }
        if path.exists() {
            return Err(ExrError::OutputExists(path.to_owned()));
        }
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if !parent.metadata().is_ok_and(|metadata| metadata.is_dir()) {
            return Err(ExrError::InvalidRequest(
                "output parent does not exist or is not a directory".into(),
            ));
        }
        Ok(())
    }
}

impl From<io::Error> for ExrError {
    fn from(error: io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

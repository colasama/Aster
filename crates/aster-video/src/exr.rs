//! Bounded OpenEXR export for linear-light RGBA frames.
//!
//! RGB samples use linear BT.709/sRGB primaries with a D65 white point and are
//! already associated (premultiplied) by alpha. Alpha is coverage in `[0, 1]`.
//! Samples are stored as provided; this backend does not color transform,
//! premultiply, or unpremultiply them.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use exr::meta::attribute::Chromaticities;
use exr::prelude::{
    AttributeValue, Encoding, Image, Layer, LayerAttributes, SpecificChannels, Text, Vec2,
    WritableImage, f16,
};
use thiserror::Error;

use crate::CancellationToken;

const MAX_PATH_UNITS: usize = 32_767;
const MAX_SEQUENCE_STEM_BYTES: usize = 64;
const MAX_SEQUENCE_PADDING: u8 = 12;
const MAX_SEQUENCE_INDEX: u64 = 999_999_999_999;
const ZIP_SCAN_LINES: u64 = 16;
static EXR_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExrPrecision {
    F16,
    F32,
}

impl ExrPrecision {
    fn bytes_per_pixel(self) -> u64 {
        match self {
            Self::F16 => 8,
            Self::F32 => 16,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ExrFrame<'pixels> {
    pub width: u32,
    pub height: u32,
    /// Row-major, associated-alpha (premultiplied) linear RGBA pixels.
    pub pixels: &'pixels [[f32; 4]],
}

#[derive(Debug, Clone)]
pub struct ExrWriteRequest<'pixels> {
    pub output_path: PathBuf,
    pub precision: ExrPrecision,
    pub frame: ExrFrame<'pixels>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExrSequenceRequest {
    pub directory: PathBuf,
    pub file_stem: String,
    pub frame_index: u64,
    pub zero_padding: u8,
    pub precision: ExrPrecision,
}

#[derive(Debug, Clone)]
pub struct ExrLimits {
    pub max_width: u32,
    pub max_height: u32,
    pub max_pixels: u64,
    pub max_input_bytes: u64,
    pub max_block_bytes: u64,
    pub max_output_bytes: u64,
}

impl Default for ExrLimits {
    fn default() -> Self {
        Self {
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
        request: &ExrWriteRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<ExrWriteReport, ExrError> {
        let validated = validate_request(request, &self.limits, cancellation)?;
        let temporary = TemporaryExr::create(&request.output_path)?;
        let overflowed = Arc::new(AtomicBool::new(false));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary.path())
            .map_err(|error| ExrError::Io(error.to_string()))?;
        let writer = BoundedCancellableFile {
            file,
            cancellation: cancellation.clone(),
            max_written_bytes: self.limits.max_output_bytes,
            position: 0,
            max_extent: 0,
            overflowed: overflowed.clone(),
        };

        let result = match request.precision {
            ExrPrecision::F16 => write_f16(request, validated, writer),
            ExrPrecision::F32 => write_f32(request, validated, writer),
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
            .path()
            .metadata()
            .map_err(|error| ExrError::Io(error.to_string()))?
            .len();
        if bytes_written > self.limits.max_output_bytes {
            return Err(ExrError::OutputTooLarge {
                limit: self.limits.max_output_bytes,
            });
        }
        temporary.publish(&request.output_path)?;
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
        frame: ExrFrame<'_>,
        cancellation: &CancellationToken,
    ) -> Result<ExrWriteReport, ExrError> {
        let output_path = sequence_output_path(sequence)?;
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

fn validate_request(
    request: &ExrWriteRequest<'_>,
    limits: &ExrLimits,
    cancellation: &CancellationToken,
) -> Result<ValidatedExr, ExrError> {
    validate_output_path(&request.output_path)?;
    let width = request.frame.width;
    let height = request.frame.height;
    if width == 0 || height == 0 || width > limits.max_width || height > limits.max_height {
        return Err(invalid("dimensions exceed the configured bounds"));
    }
    let pixel_count = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| invalid("pixel count overflowed"))?;
    if pixel_count > limits.max_pixels {
        return Err(invalid("pixel count exceeds the configured bound"));
    }
    let expected =
        usize::try_from(pixel_count).map_err(|_| invalid("pixel count cannot be represented"))?;
    if request.frame.pixels.len() != expected {
        return Err(invalid(format!(
            "pixel length was {}; expected {expected}",
            request.frame.pixels.len()
        )));
    }
    let input_bytes = pixel_count
        .checked_mul(16)
        .ok_or_else(|| invalid("input byte count overflowed"))?;
    if input_bytes > limits.max_input_bytes {
        return Err(invalid("input memory exceeds the configured bound"));
    }
    let block_bytes = u64::from(width)
        .checked_mul(ZIP_SCAN_LINES.min(u64::from(height)))
        .and_then(|samples| samples.checked_mul(request.precision.bytes_per_pixel()))
        .ok_or_else(|| invalid("codec block memory overflowed"))?;
    if block_bytes > limits.max_block_bytes {
        return Err(invalid("codec block memory exceeds the configured bound"));
    }
    validate_pixels(request.frame.pixels, request.precision, cancellation)?;
    Ok(ValidatedExr {
        width: expected / usize::try_from(height).expect("validated non-zero height"),
        height: usize::try_from(height).map_err(|_| invalid("height cannot be represented"))?,
    })
}

fn validate_pixels(
    pixels: &[[f32; 4]],
    precision: ExrPrecision,
    cancellation: &CancellationToken,
) -> Result<(), ExrError> {
    const CHANNELS: [&str; 4] = ["R", "G", "B", "A"];
    let half_max = f16::MAX.to_f32();
    for (pixel_index, pixel) in pixels.iter().enumerate() {
        if pixel_index.is_multiple_of(4096) && cancellation.is_cancelled() {
            return Err(ExrError::Cancelled);
        }
        for (channel_index, value) in pixel.iter().copied().enumerate() {
            let precision_valid = precision == ExrPrecision::F32 || value.abs() <= half_max;
            let alpha_valid = channel_index != 3 || (0.0..=1.0).contains(&value);
            if !value.is_finite() || !precision_valid || !alpha_valid {
                return Err(ExrError::InvalidPixel {
                    pixel_index,
                    channel: CHANNELS[channel_index],
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

fn write_f16(
    request: &ExrWriteRequest<'_>,
    validated: ValidatedExr,
    writer: BoundedCancellableFile,
) -> exr::error::UnitResult {
    let pixels = request.frame.pixels;
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
        layer_attributes(),
        Encoding::SMALL_LOSSLESS,
        channels,
    );
    let mut image = Image::from_layer(layer);
    decorate_image(&mut image);
    image.write().non_parallel().to_unbuffered(writer)
}

fn write_f32(
    request: &ExrWriteRequest<'_>,
    validated: ValidatedExr,
    writer: BoundedCancellableFile,
) -> exr::error::UnitResult {
    let pixels = request.frame.pixels;
    let channels = SpecificChannels::rgba(move |Vec2(x, y)| {
        let [r, g, b, a] = pixels[y * validated.width + x];
        (r, g, b, a)
    });
    let layer = Layer::new(
        (validated.width, validated.height),
        layer_attributes(),
        Encoding::SMALL_LOSSLESS,
        channels,
    );
    let mut image = Image::from_layer(layer);
    decorate_image(&mut image);
    image.write().non_parallel().to_unbuffered(writer)
}

fn layer_attributes() -> LayerAttributes {
    let mut attributes = LayerAttributes::named("rgba");
    attributes.software_name = Some(Text::from(concat!("Aster ", env!("CARGO_PKG_VERSION"))));
    attributes.other.insert(
        Text::from("asterAlphaMode"),
        AttributeValue::Text(Text::from("premultiplied_associated")),
    );
    attributes
}

fn decorate_image<Layers>(image: &mut Image<Layers>) {
    image.attributes.chromaticities = Some(bt709_chromaticities());
    image.attributes.other.insert(
        Text::from("asterColorEncoding"),
        AttributeValue::Text(Text::from("linear_bt709_d65")),
    );
}

fn bt709_chromaticities() -> Chromaticities {
    Chromaticities {
        red: Vec2(0.640, 0.330),
        green: Vec2(0.300, 0.600),
        blue: Vec2(0.150, 0.060),
        white: Vec2(0.3127, 0.3290),
    }
}

fn sequence_output_path(sequence: &ExrSequenceRequest) -> Result<PathBuf, ExrError> {
    let stem = sequence.file_stem.as_bytes();
    if stem.is_empty()
        || stem.len() > MAX_SEQUENCE_STEM_BYTES
        || !stem
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(invalid("sequence stem is not a bounded safe token"));
    }
    if !(1..=MAX_SEQUENCE_PADDING).contains(&sequence.zero_padding)
        || sequence.frame_index > MAX_SEQUENCE_INDEX
    {
        return Err(invalid("sequence frame index or padding exceeds its bound"));
    }
    let index = sequence.frame_index.to_string();
    if index.len() > usize::from(sequence.zero_padding) {
        return Err(invalid("sequence frame index exceeds its padding"));
    }
    let metadata = sequence
        .directory
        .metadata()
        .map_err(|_| invalid("sequence directory does not exist"))?;
    if !metadata.is_dir() {
        return Err(invalid("sequence output is not a directory"));
    }
    Ok(sequence.directory.join(format!(
        "{}.{:0width$}.exr",
        sequence.file_stem,
        sequence.frame_index,
        width = usize::from(sequence.zero_padding)
    )))
}

fn validate_output_path(path: &Path) -> Result<(), ExrError> {
    if path.as_os_str().is_empty()
        || path.as_os_str().to_string_lossy().encode_utf16().count() > MAX_PATH_UNITS
    {
        return Err(invalid("output path is empty or too long"));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .ok_or_else(|| invalid("output path must have a UTF-8 extension"))?;
    if !extension.eq_ignore_ascii_case("exr") {
        return Err(invalid("output path must use the .exr extension"));
    }
    if path.exists() {
        return Err(ExrError::OutputExists(path.to_owned()));
    }
    let parent = output_parent(path);
    if !parent.metadata().is_ok_and(|metadata| metadata.is_dir()) {
        return Err(invalid(
            "output parent does not exist or is not a directory",
        ));
    }
    Ok(())
}

fn output_parent(path: &Path) -> &Path {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

fn invalid(message: impl Into<String>) -> ExrError {
    ExrError::InvalidRequest(message.into())
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
            SeekFrom::Current(offset) => checked_seek_offset(self.position, offset),
            SeekFrom::End(offset) => checked_seek_offset(self.max_extent, offset),
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

fn checked_seek_offset(base: u64, offset: i64) -> Option<u64> {
    if offset >= 0 {
        base.checked_add(offset as u64)
    } else {
        base.checked_sub(offset.unsigned_abs())
    }
}

struct TemporaryExr {
    directory: PathBuf,
    path: PathBuf,
}

impl TemporaryExr {
    fn create(output: &Path) -> Result<Self, ExrError> {
        let parent = output_parent(output);
        for _ in 0..128 {
            let sequence = EXR_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let directory = parent.join(format!(".aster-exr-{}-{sequence}", std::process::id()));
            match fs::create_dir(&directory) {
                Ok(()) => {
                    return Ok(Self {
                        path: directory.join("frame.exr"),
                        directory,
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(ExrError::Io(error.to_string())),
            }
        }
        Err(ExrError::Io(
            "could not reserve a temporary OpenEXR directory".into(),
        ))
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn publish(self, output: &Path) -> Result<(), ExrError> {
        match fs::hard_link(&self.path, output) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(ExrError::OutputExists(output.to_owned()))
            }
            Err(error) => Err(ExrError::Publish(error.to_string())),
        }
    }
}

impl Drop for TemporaryExr {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}

#[cfg(test)]
#[path = "exr_tests.rs"]
mod tests;

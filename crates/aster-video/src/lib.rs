//! Decode-backend-independent video metadata, selection, and bounded caches.
//!
//! Its bounded FFmpeg backend provides the MVP's process-isolated video-frame and
//! audio-range decode. Video output is repacked into GPU-copy-aligned layouts, while
//! canonical audio remains an explicitly bounded preview/playback path.

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

mod audio;
mod ffmpeg;

pub use audio::{AudioDecodeRequest, DecodedAudio};

pub use ffmpeg::{
    CancellationToken, DecodeLimits, FfmpegBackend, FfmpegCommand, FfmpegError, FfprobeBackend,
    FfprobeCommand, FfprobeError, ProbeLimits, parse_ffprobe_json,
};

const MAX_PROBE_BYTES: usize = 1024 * 1024;
const MAX_STREAMS: usize = 128;
const MAX_DIMENSION: u32 = 32_768;
const GPU_ROW_ALIGNMENT: u64 = 256;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum VideoError {
    #[error("timebase numerator and denominator must be positive")]
    InvalidTimebase,
    #[error("timestamp arithmetic overflowed")]
    TimestampOverflow,
    #[error("probe metadata exceeds the {MAX_PROBE_BYTES} byte limit")]
    ProbeTooLarge,
    #[error("probe metadata is invalid: {0}")]
    InvalidProbe(String),
    #[error("no usable video stream was found")]
    NoVideoStream,
    #[error("invalid frame layout: {0}")]
    InvalidFrameLayout(&'static str),
}

/// Seconds per media timestamp tick, retained as an exact rational.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Timebase {
    pub numerator: u32,
    pub denominator: u32,
}

impl Timebase {
    pub fn new(numerator: u32, denominator: u32) -> Result<Self, VideoError> {
        if numerator == 0 || denominator == 0 {
            return Err(VideoError::InvalidTimebase);
        }
        let divisor = gcd(numerator, denominator);
        Ok(Self {
            numerator: numerator / divisor,
            denominator: denominator / divisor,
        })
    }

    /// Rescale a timestamp without passing through floating point.
    pub fn rescale(self, timestamp: i64, destination: Self) -> Result<i64, VideoError> {
        let value = i128::from(timestamp)
            .checked_mul(i128::from(self.numerator))
            .and_then(|value| value.checked_mul(i128::from(destination.denominator)))
            .ok_or(VideoError::TimestampOverflow)?;
        let divisor = i128::from(self.denominator) * i128::from(destination.numerator);
        let scaled = value / divisor;
        i64::try_from(scaled).map_err(|_| VideoError::TimestampOverflow)
    }

    pub fn seconds(self, timestamp: i64) -> f64 {
        timestamp as f64 * f64::from(self.numerator) / f64::from(self.denominator)
    }
}

const fn gcd(mut left: u32, mut right: u32) -> u32 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamKind {
    Video,
    Audio,
    Subtitle,
    Data,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ColorPrimaries {
    Bt709,
    Bt2020,
    DisplayP3,
    #[default]
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TransferFunction {
    Srgb,
    Bt709,
    Pq,
    Hlg,
    Linear,
    #[default]
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MatrixCoefficients {
    Identity,
    Bt709,
    Bt2020NonConstant,
    #[default]
    Unspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ColorMetadata {
    #[serde(default)]
    pub primaries: ColorPrimaries,
    #[serde(default)]
    pub transfer: TransferFunction,
    #[serde(default)]
    pub matrix: MatrixCoefficients,
    #[serde(default)]
    pub full_range: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamMetadata {
    pub index: u32,
    pub kind: StreamKind,
    pub codec: String,
    pub timebase: Timebase,
    #[serde(default)]
    pub default: bool,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub frame_rate: Option<Timebase>,
    #[serde(default)]
    pub color: ColorMetadata,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerMetadata {
    pub format: String,
    pub duration_ticks: i64,
    pub timebase: Timebase,
    pub streams: Vec<StreamMetadata>,
}

/// Parse bounded, decoder-produced JSON metadata and validate it before allocation/use.
pub fn probe_metadata(bytes: &[u8]) -> Result<ContainerMetadata, VideoError> {
    if bytes.len() > MAX_PROBE_BYTES {
        return Err(VideoError::ProbeTooLarge);
    }
    let metadata: ContainerMetadata = serde_json::from_slice(bytes)
        .map_err(|error| VideoError::InvalidProbe(error.to_string()))?;
    validate_probe(&metadata)?;
    Ok(metadata)
}

fn validate_probe(metadata: &ContainerMetadata) -> Result<(), VideoError> {
    if metadata.format.is_empty() || metadata.format.len() > 64 {
        return Err(VideoError::InvalidProbe("invalid format name".into()));
    }
    if metadata.duration_ticks < 0 {
        return Err(VideoError::InvalidProbe("negative duration".into()));
    }
    if metadata.streams.len() > MAX_STREAMS {
        return Err(VideoError::InvalidProbe("too many streams".into()));
    }
    Timebase::new(metadata.timebase.numerator, metadata.timebase.denominator)?;
    let mut indices = std::collections::HashSet::with_capacity(metadata.streams.len());
    for stream in &metadata.streams {
        if !indices.insert(stream.index) {
            return Err(VideoError::InvalidProbe("duplicate stream index".into()));
        }
        if stream.codec.is_empty() || stream.codec.len() > 64 {
            return Err(VideoError::InvalidProbe("invalid codec name".into()));
        }
        Timebase::new(stream.timebase.numerator, stream.timebase.denominator)?;
        if let Some(frame_rate) = stream.frame_rate {
            Timebase::new(frame_rate.numerator, frame_rate.denominator)?;
        }
        if stream.kind == StreamKind::Video
            && (stream.width == 0
                || stream.height == 0
                || stream.width > MAX_DIMENSION
                || stream.height > MAX_DIMENSION)
        {
            return Err(VideoError::InvalidProbe("invalid video dimensions".into()));
        }
    }
    Ok(())
}

/// Select default video first, then resolution, frame rate, and stable stream index.
pub fn select_video_stream(metadata: &ContainerMetadata) -> Result<&StreamMetadata, VideoError> {
    metadata
        .streams
        .iter()
        .filter(|stream| stream.kind == StreamKind::Video)
        .max_by(|left, right| {
            let left_pixels = u64::from(left.width) * u64::from(left.height);
            let right_pixels = u64::from(right.width) * u64::from(right.height);
            left.default
                .cmp(&right.default)
                .then(left_pixels.cmp(&right_pixels))
                .then_with(|| frame_rate_score(left).cmp(&frame_rate_score(right)))
                .then_with(|| right.index.cmp(&left.index))
        })
        .ok_or(VideoError::NoVideoStream)
}

fn frame_rate_score(stream: &StreamMetadata) -> u64 {
    stream.frame_rate.map_or(0, |rate| {
        u64::from(rate.denominator)
            .saturating_mul(1_000_000)
            .checked_div(u64::from(rate.numerator))
            .unwrap_or(0)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PacketKey {
    pub stream_index: u32,
    pub decode_timestamp: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FrameKey {
    pub stream_index: u32,
    pub presentation_timestamp: i64,
}

#[derive(Debug, Clone)]
pub struct Packet {
    pub presentation_timestamp: i64,
    pub duration: i64,
    pub keyframe: bool,
    pub bytes: Arc<[u8]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GpuPixelFormat {
    Nv12,
    P010,
    Rgba8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GpuPlaneDescriptor {
    pub offset: u64,
    pub bytes_per_row: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GpuFrameDescriptor {
    pub width: u32,
    pub height: u32,
    pub format: GpuPixelFormat,
    pub color: ColorMetadata,
    pub planes: Vec<GpuPlaneDescriptor>,
    pub allocation_size: u64,
}

impl GpuFrameDescriptor {
    /// Create a 256-byte-row-aligned layout suitable for direct staging-buffer copies.
    pub fn aligned(
        width: u32,
        height: u32,
        format: GpuPixelFormat,
        color: ColorMetadata,
    ) -> Result<Self, VideoError> {
        if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
            return Err(VideoError::InvalidFrameLayout("dimensions out of range"));
        }
        if matches!(format, GpuPixelFormat::Nv12 | GpuPixelFormat::P010)
            && (!width.is_multiple_of(2) || !height.is_multiple_of(2))
        {
            return Err(VideoError::InvalidFrameLayout(
                "4:2:0 frames must be even-sized",
            ));
        }
        let (row_bytes, plane_rows): (Vec<u64>, Vec<u32>) = match format {
            GpuPixelFormat::Nv12 => (
                vec![u64::from(width), u64::from(width)],
                vec![height, height / 2],
            ),
            GpuPixelFormat::P010 => (
                vec![u64::from(width) * 2, u64::from(width) * 2],
                vec![height, height / 2],
            ),
            GpuPixelFormat::Rgba8 => (vec![u64::from(width) * 4], vec![height]),
        };
        let mut offset = 0_u64;
        let mut planes = Vec::with_capacity(row_bytes.len());
        for (row_bytes, rows) in row_bytes.into_iter().zip(plane_rows) {
            let stride = align_up(row_bytes, GPU_ROW_ALIGNMENT)?;
            let size = stride
                .checked_mul(u64::from(rows))
                .ok_or(VideoError::InvalidFrameLayout("allocation overflow"))?;
            planes.push(GpuPlaneDescriptor {
                offset,
                bytes_per_row: u32::try_from(stride)
                    .map_err(|_| VideoError::InvalidFrameLayout("row stride overflow"))?,
                rows,
            });
            offset = offset
                .checked_add(size)
                .ok_or(VideoError::InvalidFrameLayout("allocation overflow"))?;
        }
        Ok(Self {
            width,
            height,
            format,
            color,
            planes,
            allocation_size: offset,
        })
    }
}

fn align_up(value: u64, alignment: u64) -> Result<u64, VideoError> {
    value
        .checked_add(alignment - 1)
        .map(|value| value / alignment * alignment)
        .ok_or(VideoError::InvalidFrameLayout("alignment overflow"))
}

#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub descriptor: GpuFrameDescriptor,
    pub duration: i64,
    pub bytes: Arc<[u8]>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CacheStatistics {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub entries: usize,
    pub bytes: u64,
    pub budget_bytes: u64,
}

#[derive(Debug)]
struct CacheEntry<V> {
    value: V,
    bytes: u64,
    age: u64,
}

#[derive(Debug)]
struct WeightedLru<K, V> {
    entries: HashMap<K, CacheEntry<V>>,
    budget: u64,
    used: u64,
    clock: u64,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl<K: Eq + Hash + Clone, V> WeightedLru<K, V> {
    fn new(budget: u64) -> Self {
        Self {
            entries: HashMap::new(),
            budget,
            used: 0,
            clock: 0,
            hits: 0,
            misses: 0,
            evictions: 0,
        }
    }

    fn get(&mut self, key: &K) -> Option<&V> {
        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self.entries.get_mut(key) {
            self.hits += 1;
            entry.age = self.clock;
            Some(&entry.value)
        } else {
            self.misses += 1;
            None
        }
    }

    fn insert(&mut self, key: K, value: V, bytes: u64) -> bool {
        if bytes > self.budget {
            return false;
        }
        self.clock = self.clock.wrapping_add(1);
        if let Some(previous) = self.entries.remove(&key) {
            self.used -= previous.bytes;
        }
        while self.used.saturating_add(bytes) > self.budget {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.age)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            if let Some(removed) = self.entries.remove(&oldest) {
                self.used -= removed.bytes;
                self.evictions += 1;
            }
        }
        self.entries.insert(
            key,
            CacheEntry {
                value,
                bytes,
                age: self.clock,
            },
        );
        self.used += bytes;
        true
    }

    fn statistics(&self) -> CacheStatistics {
        CacheStatistics {
            hits: self.hits,
            misses: self.misses,
            evictions: self.evictions,
            entries: self.entries.len(),
            bytes: self.used,
            budget_bytes: self.budget,
        }
    }
}

#[derive(Debug)]
pub struct PacketCache(WeightedLru<PacketKey, Packet>);

/// Compressed packets waiting for decoder submission, indexed by exact decode timestamp.
pub type DecodeCache = PacketCache;

impl PacketCache {
    pub fn new(budget_bytes: u64) -> Self {
        Self(WeightedLru::new(budget_bytes))
    }
    pub fn get(&mut self, key: &PacketKey) -> Option<&Packet> {
        self.0.get(key)
    }
    pub fn insert(&mut self, key: PacketKey, packet: Packet) -> bool {
        let bytes = packet.bytes.len() as u64;
        self.0.insert(key, packet, bytes)
    }
    pub fn statistics(&self) -> CacheStatistics {
        self.0.statistics()
    }
}

#[derive(Debug)]
pub struct FrameCache(WeightedLru<FrameKey, DecodedFrame>);

impl FrameCache {
    pub fn new(budget_bytes: u64) -> Self {
        Self(WeightedLru::new(budget_bytes))
    }
    pub fn get(&mut self, key: &FrameKey) -> Option<&DecodedFrame> {
        self.0.get(key)
    }
    pub fn insert(&mut self, key: FrameKey, frame: DecodedFrame) -> bool {
        let bytes = (frame.bytes.len() as u64).max(frame.descriptor.allocation_size);
        self.0.insert(key, frame, bytes)
    }
    pub fn statistics(&self) -> CacheStatistics {
        self.0.statistics()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stream(index: u32, default: bool, width: u32, height: u32) -> StreamMetadata {
        StreamMetadata {
            index,
            kind: StreamKind::Video,
            codec: "av1".into(),
            timebase: Timebase::new(1, 90_000).unwrap(),
            default,
            width,
            height,
            frame_rate: Some(Timebase::new(1, 60).unwrap()),
            color: ColorMetadata::default(),
        }
    }

    #[test]
    fn rescales_large_timestamps_exactly() {
        let clock = Timebase::new(1, 90_000).unwrap();
        let milliseconds = Timebase::new(1, 1_000).unwrap();
        assert_eq!(clock.rescale(810_000, milliseconds), Ok(9_000));
        assert_eq!(
            Timebase::new(2, 4),
            Ok(Timebase {
                numerator: 1,
                denominator: 2
            })
        );
    }

    #[test]
    fn probes_metadata_and_selects_default_stream() {
        let metadata = ContainerMetadata {
            format: "matroska".into(),
            duration_ticks: 90_000,
            timebase: Timebase::new(1, 1_000).unwrap(),
            streams: vec![stream(0, false, 3840, 2160), stream(1, true, 1920, 1080)],
        };
        let bytes = serde_json::to_vec(&metadata).unwrap();
        let parsed = probe_metadata(&bytes).unwrap();
        assert_eq!(select_video_stream(&parsed).unwrap().index, 1);
    }

    #[test]
    fn rejects_unsafe_probe_shapes() {
        let metadata = ContainerMetadata {
            format: "mp4".into(),
            duration_ticks: 0,
            timebase: Timebase::new(1, 1_000).unwrap(),
            streams: vec![stream(0, false, MAX_DIMENSION + 1, 10)],
        };
        assert!(matches!(
            probe_metadata(&serde_json::to_vec(&metadata).unwrap()),
            Err(VideoError::InvalidProbe(_))
        ));
        assert_eq!(
            probe_metadata(&vec![b' '; MAX_PROBE_BYTES + 1]),
            Err(VideoError::ProbeTooLarge)
        );
    }

    #[test]
    fn creates_gpu_aligned_multiplane_layouts() {
        let frame =
            GpuFrameDescriptor::aligned(1920, 1080, GpuPixelFormat::Nv12, ColorMetadata::default())
                .unwrap();
        assert_eq!(frame.planes.len(), 2);
        assert!(
            frame
                .planes
                .iter()
                .all(|plane| plane.bytes_per_row % 256 == 0)
        );
        assert_eq!(
            frame.planes[1].offset,
            u64::from(frame.planes[0].bytes_per_row) * 1080
        );
        assert!(
            GpuFrameDescriptor::aligned(1919, 1080, GpuPixelFormat::Nv12, ColorMetadata::default())
                .is_err()
        );
    }

    #[test]
    fn packet_cache_is_bounded_and_lru() {
        let mut cache = PacketCache::new(8);
        let make = |value| Packet {
            presentation_timestamp: value,
            duration: 1,
            keyframe: false,
            bytes: Arc::from([value as u8; 4]),
        };
        let first = PacketKey {
            stream_index: 0,
            decode_timestamp: 1,
        };
        let second = PacketKey {
            stream_index: 0,
            decode_timestamp: 2,
        };
        let third = PacketKey {
            stream_index: 0,
            decode_timestamp: 3,
        };
        assert!(cache.insert(first, make(1)));
        assert!(cache.insert(second, make(2)));
        assert!(cache.get(&first).is_some());
        assert!(cache.insert(third, make(3)));
        assert!(cache.get(&second).is_none());
        assert_eq!(cache.statistics().evictions, 1);
        assert_eq!(cache.statistics().bytes, 8);
    }

    #[test]
    fn frame_cache_rejects_oversized_values_without_eviction() {
        let descriptor =
            GpuFrameDescriptor::aligned(2, 2, GpuPixelFormat::Rgba8, ColorMetadata::default())
                .unwrap();
        let mut cache = FrameCache::new(4);
        let frame = DecodedFrame {
            descriptor,
            duration: 1,
            bytes: Arc::from([0_u8; 8]),
        };
        assert!(!cache.insert(
            FrameKey {
                stream_index: 0,
                presentation_timestamp: 0
            },
            frame
        ));
        assert_eq!(cache.statistics().entries, 0);
    }
}

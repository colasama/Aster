use crate::{ColorMetadata, MetadataLimits, VideoError};
use std::sync::Arc;

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
    pub const ROW_ALIGNMENT: u64 = 256;
    /// Create a 256-byte-row-aligned layout suitable for direct staging-buffer copies.
    pub fn aligned(
        width: u32,
        height: u32,
        format: GpuPixelFormat,
        color: ColorMetadata,
        limits: &MetadataLimits,
    ) -> Result<Self, VideoError> {
        if width == 0
            || height == 0
            || width > limits.max_dimension
            || height > limits.max_dimension
        {
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
            let stride = row_bytes.div_ceil(Self::ROW_ALIGNMENT) * Self::ROW_ALIGNMENT;
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

#[derive(Debug, Clone)]
pub struct DecodedFrame {
    pub descriptor: GpuFrameDescriptor,
    pub duration: i64,
    pub bytes: Arc<[u8]>,
}

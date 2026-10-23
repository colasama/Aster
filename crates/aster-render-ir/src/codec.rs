use std::ops::Range;

use crate::{FramePlanSliceV1, IrError, canonical::CanonicalJson, wire::WireHeader};

#[derive(Clone, Debug)]
pub struct DecodeLimits {
    pub max_container_bytes: usize,
    pub max_metadata_bytes: usize,
    pub max_blobs: usize,
    pub max_slices: usize,
    pub max_resource_references: usize,
    pub max_dimension: u32,
    pub max_pixels: u64,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_container_bytes: 67_108_864,
            max_metadata_bytes: 1_048_576,
            max_blobs: 4096,
            max_slices: 4096,
            max_resource_references: 65_536,
            max_dimension: 16_384,
            max_pixels: 268_435_456,
        }
    }
}

impl DecodeLimits {
    pub fn validate(&self) -> Result<(), IrError> {
        if self.max_container_bytes < 32
            || self.max_container_bytes > u32::MAX as usize
            || self.max_metadata_bytes == 0
            || self.max_metadata_bytes > self.max_container_bytes
            || self.max_blobs == 0
            || self.max_blobs > u32::MAX as usize
            || self.max_slices == 0
            || self.max_slices > u32::MAX as usize
            || self.max_resource_references > u32::MAX as usize
            || self.max_dimension == 0
            || self.max_dimension > 16_777_216
            || self.max_pixels == 0
            || self.max_pixels > 9_007_199_254_740_991
        {
            return Err(IrError::LimitExceeded("invalid caller limits".to_owned()));
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct OwnedFpln {
    pub metadata: FramePlanSliceV1,
    bytes: Vec<u8>,
    ranges: Vec<Range<usize>>,
}

impl OwnedFpln {
    pub fn blob(&self, index: usize) -> Result<&[u8], IrError> {
        let range = self.ranges.get(index).ok_or(IrError::BlobCountMismatch)?;
        self.bytes
            .get(range.clone())
            .ok_or(IrError::BlobRangeOutOfBounds)
    }

    pub fn reencode(&self, limits: &DecodeLimits) -> Result<Vec<u8>, IrError> {
        let blobs = (0..self.ranges.len())
            .map(|index| self.blob(index))
            .collect::<Result<Vec<_>, _>>()?;
        FplnCodec::encode(self.metadata.clone(), &blobs, limits)
    }

    pub fn metadata_json(&self, limits: &DecodeLimits) -> Result<Vec<u8>, IrError> {
        self.metadata.validate(limits)?;
        CanonicalJson::encode(&self.metadata)
    }
}

pub struct FplnCodec;

impl FplnCodec {
    pub fn encode(
        metadata: FramePlanSliceV1,
        blobs: &[&[u8]],
        limits: &DecodeLimits,
    ) -> Result<Vec<u8>, IrError> {
        let plan = Self::encode_owned(metadata, blobs, limits)?;
        Ok(plan.bytes)
    }

    /// Keep the validated typed metadata when an in-process producer needs the plan immediately.
    pub fn encode_owned(
        mut metadata: FramePlanSliceV1,
        blobs: &[&[u8]],
        limits: &DecodeLimits,
    ) -> Result<OwnedFpln, IrError> {
        metadata.validate(limits)?;
        if metadata.blobs.len() != blobs.len() {
            return Err(IrError::BlobCountMismatch);
        }
        let mut cursor = 0_u32;
        for (descriptor, bytes) in metadata.blobs.iter_mut().zip(blobs) {
            if bytes.len() != descriptor.byte_length as usize {
                return Err(IrError::ElementCountMismatch);
            }
            descriptor.byte_offset = cursor;
            cursor = WireHeader::align16(
                cursor
                    .checked_add(descriptor.byte_length)
                    .ok_or(IrError::ArithmeticOverflow)?,
            )?;
        }
        for (index, blob) in blobs.iter().enumerate() {
            metadata.validate_blob(index, blob)?;
        }
        let json = CanonicalJson::encode(&metadata)?;
        if json.len() > limits.max_metadata_bytes {
            return Err(IrError::LimitExceeded("metadata bytes".to_owned()));
        }
        let json_length = u32::try_from(json.len()).map_err(|_| IrError::ArithmeticOverflow)?;
        let blob_start = WireHeader::align16(
            32_u32
                .checked_add(json_length)
                .ok_or(IrError::ArithmeticOverflow)?,
        )?;
        let total = blob_start
            .checked_add(cursor)
            .ok_or(IrError::ArithmeticOverflow)?;
        if total as usize > limits.max_container_bytes {
            return Err(IrError::LimitExceeded("container bytes".to_owned()));
        }
        let header = WireHeader {
            metadata_bytes: json_length,
            blob_count: u32::try_from(blobs.len()).map_err(|_| IrError::ArithmeticOverflow)?,
            blob_section_offset: blob_start,
            container_bytes: total,
        };
        let mut output = vec![0; total as usize];
        header.write(&mut output)?;
        output[32..32 + json.len()].copy_from_slice(&json);
        let mut ranges = Vec::with_capacity(blobs.len());
        for (descriptor, bytes) in metadata.blobs.iter().zip(blobs) {
            let start = blob_start
                .checked_add(descriptor.byte_offset)
                .ok_or(IrError::ArithmeticOverflow)? as usize;
            let end = start
                .checked_add(bytes.len())
                .ok_or(IrError::ArithmeticOverflow)?;
            output
                .get_mut(start..end)
                .ok_or(IrError::BlobRangeOutOfBounds)?
                .copy_from_slice(bytes);
            ranges.push(start..end);
        }
        Ok(OwnedFpln {
            metadata,
            bytes: output,
            ranges,
        })
    }

    pub fn decode(bytes: Vec<u8>, limits: &DecodeLimits) -> Result<OwnedFpln, IrError> {
        limits.validate()?;
        let header = WireHeader::read(&bytes)?;
        if bytes.len() > limits.max_container_bytes
            || header.metadata_bytes as usize > limits.max_metadata_bytes
            || header.blob_count as usize > limits.max_blobs
        {
            return Err(IrError::LimitExceeded("header length or count".to_owned()));
        }
        if header.container_bytes as usize != bytes.len() {
            return Err(IrError::ContainerLengthMismatch);
        }
        let json_end = 32_u32
            .checked_add(header.metadata_bytes)
            .ok_or(IrError::ArithmeticOverflow)?;
        if header.blob_section_offset != WireHeader::align16(json_end)? {
            return Err(IrError::InvalidPadding);
        }
        let json = bytes
            .get(32..json_end as usize)
            .ok_or(IrError::BlobRangeOutOfBounds)?;
        std::str::from_utf8(json).map_err(|_| IrError::InvalidUtf8)?;
        let metadata: FramePlanSliceV1 = serde_json::from_slice(json)
            .map_err(|error| IrError::InvalidJson(error.to_string()))?;
        metadata.validate(limits)?;
        if metadata.blobs.len() != header.blob_count as usize {
            return Err(IrError::BlobCountMismatch);
        }
        if CanonicalJson::encode(&metadata)? != json {
            return Err(IrError::NonCanonicalMetadata);
        }
        let gap = bytes
            .get(json_end as usize..header.blob_section_offset as usize)
            .ok_or(IrError::BlobRangeOutOfBounds)?;
        if gap.iter().any(|byte| *byte != 0) {
            return Err(IrError::InvalidPadding);
        }
        let mut cursor = 0_u32;
        let mut ranges = Vec::with_capacity(metadata.blobs.len());
        for descriptor in &metadata.blobs {
            if !descriptor.byte_offset.is_multiple_of(16) {
                return Err(IrError::BlobMisaligned);
            }
            if descriptor.byte_offset < cursor {
                return Err(IrError::BlobOverlap);
            }
            if descriptor.byte_offset != cursor {
                return Err(IrError::InvalidPadding);
            }
            let relative_end = cursor
                .checked_add(descriptor.byte_length)
                .ok_or(IrError::ArithmeticOverflow)?;
            let start = header
                .blob_section_offset
                .checked_add(cursor)
                .ok_or(IrError::ArithmeticOverflow)?;
            let end = header
                .blob_section_offset
                .checked_add(relative_end)
                .ok_or(IrError::ArithmeticOverflow)?;
            let blob = bytes
                .get(start as usize..end as usize)
                .ok_or(IrError::BlobRangeOutOfBounds)?;
            metadata.validate_blob(ranges.len(), blob)?;
            cursor = WireHeader::align16(relative_end)?;
            let aligned_end = header
                .blob_section_offset
                .checked_add(cursor)
                .ok_or(IrError::ArithmeticOverflow)?;
            let gap = bytes
                .get(end as usize..aligned_end as usize)
                .ok_or(IrError::BlobRangeOutOfBounds)?;
            if gap.iter().any(|byte| *byte != 0) {
                return Err(IrError::InvalidPadding);
            }
            ranges.push(start as usize..end as usize);
        }
        if header
            .blob_section_offset
            .checked_add(cursor)
            .ok_or(IrError::ArithmeticOverflow)?
            != header.container_bytes
        {
            return Err(IrError::ContainerLengthMismatch);
        }
        Ok(OwnedFpln {
            metadata,
            bytes,
            ranges,
        })
    }
}

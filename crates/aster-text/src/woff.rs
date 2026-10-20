use flate2::{Decompress, FlushDecompress, Status};

use crate::FontCatalogError;

struct WoffTable {
    tag: [u8; 4],
    offset: usize,
    compressed: usize,
    original: usize,
    checksum: u32,
}

/// Validates the complete container before allocating the reconstructed SFNT.
pub(crate) struct WoffDecoder;

impl WoffDecoder {
    pub fn decode(
        bytes: &[u8],
        budget: usize,
        max_tables: usize,
    ) -> Result<Vec<u8>, FontCatalogError> {
        let invalid = FontCatalogError::Invalid("invalid WOFF1 container");
        if bytes.len() < 44 || !bytes.starts_with(b"wOFF") {
            return Err(invalid);
        }
        let flavor = Self::u32(bytes, 4)?;
        let count = usize::from(Self::u16(bytes, 12)?);
        let declared = Self::u32(bytes, 16)? as usize;
        if ![0x0001_0000, 0x4f54_544f].contains(&flavor)
            || Self::u32(bytes, 8)? as usize != bytes.len()
            || Self::u16(bytes, 14)? != 0
            || count == 0
            || count > max_tables.min(4095)
            || declared > budget
        {
            return Err(invalid);
        }
        let directory_end = 44 + 20 * count;
        if directory_end > bytes.len() {
            return Err(invalid);
        }
        let mut spans = vec![(0, directory_end)];
        for (offset_position, length_position, original_position) in
            [(24, 28, Some(32)), (36, 40, None)]
        {
            let offset = Self::u32(bytes, offset_position)? as usize;
            let length = Self::u32(bytes, length_position)? as usize;
            let original = original_position.map(|p| Self::u32(bytes, p)).transpose()?;
            if offset == 0 {
                if length != 0 || original.is_some_and(|v| v != 0) {
                    return Err(invalid);
                }
            } else {
                if length == 0
                    || original == Some(0)
                    || !offset.is_multiple_of(4)
                    || offset > bytes.len()
                    || length > bytes.len() - offset
                {
                    return Err(invalid);
                }
                spans.push((offset, offset + length));
            }
        }
        let mut tables = Vec::with_capacity(count);
        let mut output_size = 12 + 16 * count;
        let mut last_tag = None;
        for index in 0..count {
            let position = 44 + 20 * index;
            let tag = Self::u32(bytes, position)?.to_be_bytes();
            let table = WoffTable {
                tag,
                offset: Self::u32(bytes, position + 4)? as usize,
                compressed: Self::u32(bytes, position + 8)? as usize,
                original: Self::u32(bytes, position + 12)? as usize,
                checksum: Self::u32(bytes, position + 16)?,
            };
            if last_tag.is_some_and(|previous| previous >= tag)
                || table.compressed > table.original
                || !table.offset.is_multiple_of(4)
                || table.offset > bytes.len()
                || table.compressed > bytes.len() - table.offset
                || (table.tag == *b"head" && table.original < 12)
            {
                return Err(invalid);
            }
            let padded = table
                .original
                .checked_add(3)
                .ok_or(FontCatalogError::Limit("decoded font bytes"))?
                & !3;
            output_size = output_size
                .checked_add(padded)
                .filter(|size| *size <= budget)
                .ok_or(FontCatalogError::Limit("decoded font bytes"))?;
            spans.push((table.offset, table.offset + table.compressed));
            last_tag = Some(tag);
            tables.push(table);
        }
        spans.sort_unstable();
        if output_size != declared
            || spans.windows(2).any(|pair| {
                pair[0].1 > pair[1].0
                    || pair[1].0 - pair[0].1 > 3
                    || bytes[pair[0].1..pair[1].0].iter().any(|byte| *byte != 0)
            })
        {
            return Err(invalid);
        }
        let end = spans.last().map_or(directory_end, |span| span.1);
        if bytes.len() - end > 3 || bytes[end..].iter().any(|byte| *byte != 0) {
            return Err(invalid);
        }
        let table_end = tables
            .iter()
            .map(|table| table.offset + table.compressed)
            .max()
            .ok_or(FontCatalogError::Invalid("WOFF tables missing"))?;
        let metadata = Self::u32(bytes, 24)? as usize;
        let private = Self::u32(bytes, 36)? as usize;
        if (metadata != 0 && metadata < table_end)
            || (private != 0 && private < table_end)
            || (metadata != 0
                && private != 0
                && metadata + Self::u32(bytes, 28)? as usize > private)
        {
            return Err(invalid);
        }
        let mut output = vec![0; output_size];
        output[..4].copy_from_slice(&flavor.to_be_bytes());
        output[4..6].copy_from_slice(&(count as u16).to_be_bytes());
        let selector = count.ilog2() as u16;
        let search_range = 16 * (1_u16 << selector);
        output[6..8].copy_from_slice(&search_range.to_be_bytes());
        output[8..10].copy_from_slice(&selector.to_be_bytes());
        output[10..12].copy_from_slice(&(16 * count as u16 - search_range).to_be_bytes());
        let mut offset = 12 + 16 * count;
        let mut head = None;
        for (index, table) in tables.iter().enumerate() {
            let source = &bytes[table.offset..table.offset + table.compressed];
            let destination = &mut output[offset..offset + table.original];
            if table.compressed == table.original {
                destination.copy_from_slice(source);
            } else {
                let mut decoder = Decompress::new(true);
                let status = decoder
                    .decompress(source, destination, FlushDecompress::Finish)
                    .map_err(|_| FontCatalogError::Invalid("invalid WOFF zlib stream"))?;
                if status != Status::StreamEnd
                    || decoder.total_in() != source.len() as u64
                    || decoder.total_out() != destination.len() as u64
                {
                    return Err(FontCatalogError::Invalid("WOFF decoded length differs"));
                }
            }
            if table.tag == *b"head" {
                destination[8..12].fill(0);
                head = Some(offset);
            }
            if Self::checksum(destination) != table.checksum {
                return Err(FontCatalogError::Invalid("WOFF table checksum differs"));
            }
            let directory = 12 + 16 * index;
            output[directory..directory + 4].copy_from_slice(&table.tag);
            output[directory + 4..directory + 8].copy_from_slice(&table.checksum.to_be_bytes());
            output[directory + 8..directory + 12].copy_from_slice(&(offset as u32).to_be_bytes());
            output[directory + 12..directory + 16]
                .copy_from_slice(&(table.original as u32).to_be_bytes());
            offset += (table.original + 3) & !3;
        }
        let head = head.ok_or(FontCatalogError::Invalid("WOFF head table missing"))?;
        let adjustment = 0xb1b0_afba_u32.wrapping_sub(Self::checksum(&output));
        output[head + 8..head + 12].copy_from_slice(&adjustment.to_be_bytes());
        Ok(output)
    }

    pub(crate) fn checksum(bytes: &[u8]) -> u32 {
        bytes.chunks(4).fold(0_u32, |sum, chunk| {
            let mut word = [0; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            sum.wrapping_add(u32::from_be_bytes(word))
        })
    }

    fn u16(bytes: &[u8], offset: usize) -> Result<u16, FontCatalogError> {
        let bytes = bytes
            .get(offset..offset + 2)
            .ok_or(FontCatalogError::Invalid("truncated WOFF field"))?;
        Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    fn u32(bytes: &[u8], offset: usize) -> Result<u32, FontCatalogError> {
        let bytes = bytes
            .get(offset..offset + 4)
            .ok_or(FontCatalogError::Invalid("truncated WOFF field"))?;
        Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }
}

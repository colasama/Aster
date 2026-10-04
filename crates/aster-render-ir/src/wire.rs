use crate::IrError;

pub(crate) struct WireHeader {
    pub metadata_bytes: u32,
    pub blob_count: u32,
    pub blob_section_offset: u32,
    pub container_bytes: u32,
}

impl WireHeader {
    pub(crate) fn read(bytes: &[u8]) -> Result<Self, IrError> {
        if bytes.len() < 32 {
            return Err(IrError::TruncatedHeader);
        }
        if &bytes[..4] != b"FPLN" {
            return Err(IrError::InvalidMagic);
        }
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        if version != 1 {
            return Err(IrError::UnsupportedVersion(version));
        }
        if u16::from_le_bytes([bytes[6], bytes[7]]) != 32
            || Self::u32_at(bytes, 24)? != 0
            || Self::u32_at(bytes, 28)? != 0
        {
            return Err(IrError::InvalidHeader(
                "header size, flags or reserved bits".to_owned(),
            ));
        }
        Ok(Self {
            metadata_bytes: Self::u32_at(bytes, 8)?,
            blob_count: Self::u32_at(bytes, 12)?,
            blob_section_offset: Self::u32_at(bytes, 16)?,
            container_bytes: Self::u32_at(bytes, 20)?,
        })
    }

    pub(crate) fn write(&self, output: &mut [u8]) -> Result<(), IrError> {
        let header = output.get_mut(..32).ok_or(IrError::TruncatedHeader)?;
        header.fill(0);
        header[..4].copy_from_slice(b"FPLN");
        header[4..6].copy_from_slice(&1_u16.to_le_bytes());
        header[6..8].copy_from_slice(&32_u16.to_le_bytes());
        for (offset, value) in [
            (8, self.metadata_bytes),
            (12, self.blob_count),
            (16, self.blob_section_offset),
            (20, self.container_bytes),
        ] {
            header[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        }
        Ok(())
    }

    pub(crate) fn align16(value: u32) -> Result<u32, IrError> {
        let incremented = value.checked_add(15).ok_or(IrError::ArithmeticOverflow)?;
        Ok(incremented & !15)
    }

    fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, IrError> {
        let end = offset.checked_add(4).ok_or(IrError::ArithmeticOverflow)?;
        let word = bytes.get(offset..end).ok_or(IrError::TruncatedHeader)?;
        Ok(u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
    }
}

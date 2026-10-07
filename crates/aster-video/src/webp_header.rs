use crate::FfmpegError;

pub(crate) struct WebpHeader;

impl WebpHeader {
    /// Inspect bounded RIFF chunks before the codec can allocate a decoded image.
    pub fn dimensions(bytes: &[u8]) -> Result<(u32, u32), FfmpegError> {
        let invalid = || FfmpegError::InvalidMetadata("malformed WebP still".into());
        if bytes.len() < 20 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
            return Err(invalid());
        }
        let length = u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| invalid())?) as u64;
        if length + 8 != bytes.len() as u64 {
            return Err(invalid());
        }
        let mut offset = 12;
        let mut canvas = None;
        let mut image = None;
        let mut animated = false;
        let mut animation_header = false;
        let mut frames = 0;
        while offset < bytes.len() {
            let header = bytes.get(offset..offset + 8).ok_or_else(invalid)?;
            let count =
                u32::from_le_bytes(header[4..8].try_into().map_err(|_| invalid())?) as usize;
            let end = offset
                .checked_add(8)
                .and_then(|n| n.checked_add(count))
                .ok_or_else(invalid)?;
            let data = bytes.get(offset + 8..end).ok_or_else(invalid)?;
            let size = match &header[..4] {
                b"VP8X"
                    if offset == 12
                        && count == 10
                        && data[0] & 0xc1 == 0
                        && data[1..4] == [0, 0, 0] =>
                {
                    animated = data[0] & 2 != 0;
                    canvas = Some((
                        1 + u32::from_le_bytes([data[4], data[5], data[6], 0]),
                        1 + u32::from_le_bytes([data[7], data[8], data[9], 0]),
                    ));
                    None
                }
                b"ANIM" if animated && !animation_header && count == 6 => {
                    animation_header = true;
                    None
                }
                b"ANMF" if animation_header => {
                    Self::frame(data, canvas.ok_or_else(invalid)?)?;
                    frames += 1;
                    None
                }
                b"VP8 "
                    if !animated
                        && count >= 10
                        && data[0] & 1 == 0
                        && data[3..6] == [0x9d, 0x01, 0x2a] =>
                {
                    Some((
                        u32::from(u16::from_le_bytes([data[6], data[7]]) & 0x3fff),
                        u32::from(u16::from_le_bytes([data[8], data[9]]) & 0x3fff),
                    ))
                }
                b"VP8L" if !animated && count >= 5 && data[0] == 0x2f && data[4] & 0xe0 == 0 => {
                    let bits = u32::from_le_bytes([data[1], data[2], data[3], data[4]]);
                    Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)))
                }
                b"ANIM" | b"ANMF" | b"VP8X" | b"VP8 " | b"VP8L" => return Err(invalid()),
                _ => None,
            };
            if let Some(size) = size
                && (image.replace(size).is_some() || size.0 == 0 || size.1 == 0)
            {
                return Err(invalid());
            }
            offset = end.checked_add(count & 1).ok_or_else(invalid)?;
            if offset > bytes.len() {
                return Err(invalid());
            }
        }
        if animated {
            return canvas
                .filter(|_| animation_header && frames > 0)
                .ok_or_else(invalid);
        }
        let size = image.ok_or_else(invalid)?;
        if canvas.is_some_and(|canvas| canvas != size) {
            return Err(invalid());
        }
        Ok(size)
    }

    /// Validate every subframe's bitstream extent before the codec allocates or composites it.
    fn frame(data: &[u8], canvas: (u32, u32)) -> Result<(), FfmpegError> {
        let invalid = || FfmpegError::InvalidMetadata("malformed WebP animation frame".into());
        let header = data.get(..16).ok_or_else(invalid)?;
        let u24 = |start: usize| {
            u32::from_le_bytes([header[start], header[start + 1], header[start + 2], 0])
        };
        let size = (u24(6) + 1, u24(9) + 1);
        if header[15] & !3 != 0 || u24(0) * 2 + size.0 > canvas.0 || u24(3) * 2 + size.1 > canvas.1
        {
            return Err(invalid());
        }
        let mut offset: usize = 16;
        let mut image = None;
        let mut alpha = false;
        while offset < data.len() {
            let header = data.get(offset..offset + 8).ok_or_else(invalid)?;
            let count =
                u32::from_le_bytes(header[4..8].try_into().map_err(|_| invalid())?) as usize;
            let end = offset
                .checked_add(8)
                .and_then(|n| n.checked_add(count))
                .ok_or_else(invalid)?;
            let chunk = data.get(offset + 8..end).ok_or_else(invalid)?;
            let decoded = match &header[..4] {
                b"ALPH" if !alpha && image.is_none() && count > 0 => {
                    alpha = true;
                    None
                }
                b"VP8 "
                    if count >= 10 && chunk[0] & 1 == 0 && chunk[3..6] == [0x9d, 0x01, 0x2a] =>
                {
                    Some((
                        u32::from(u16::from_le_bytes([chunk[6], chunk[7]]) & 0x3fff),
                        u32::from(u16::from_le_bytes([chunk[8], chunk[9]]) & 0x3fff),
                    ))
                }
                b"VP8L" if !alpha && count >= 5 && chunk[0] == 0x2f && chunk[4] & 0xe0 == 0 => {
                    let bits = u32::from_le_bytes([chunk[1], chunk[2], chunk[3], chunk[4]]);
                    Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)))
                }
                _ => return Err(invalid()),
            };
            if let Some(decoded) = decoded
                && (decoded != size || image.replace(decoded).is_some())
            {
                return Err(invalid());
            }
            offset = end.checked_add(count & 1).ok_or_else(invalid)?;
            if offset > data.len() {
                return Err(invalid());
            }
        }
        if image.is_none() {
            return Err(invalid());
        }
        Ok(())
    }
}

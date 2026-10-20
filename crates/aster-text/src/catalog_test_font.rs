use std::{collections::BTreeMap, sync::Arc};

use sha2::{Digest, Sha256};

use crate::{FontAxis, FontId, FontStyle, LoadedFont};

pub(super) struct TestFont {
    pub family: String,
    pub weight: u16,
    pub width: u16,
    pub style: FontStyle,
    pub axes: Vec<FontAxis>,
}

impl TestFont {
    pub fn new(family: &str, weight: u16) -> Self {
        Self {
            family: family.to_owned(),
            weight,
            width: 5,
            style: FontStyle::Normal,
            axes: Vec::new(),
        }
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut tables = BTreeMap::new();
        let mut head = vec![0; 54];
        head[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        head[12..16].copy_from_slice(&0x5f0f_3cf5_u32.to_be_bytes());
        head[18..20].copy_from_slice(&1000_u16.to_be_bytes());
        tables.insert(*b"head", head);
        let mut maxp = 0x0000_5000_u32.to_be_bytes().to_vec();
        maxp.extend(10_u16.to_be_bytes());
        tables.insert(*b"maxp", maxp);
        let mut os2 = vec![0; 78];
        os2[4..6].copy_from_slice(&self.weight.to_be_bytes());
        os2[6..8].copy_from_slice(&self.width.to_be_bytes());
        let flags: u16 = match self.style {
            FontStyle::Normal => 0x0040,
            FontStyle::Italic => 0x0001,
            FontStyle::Oblique => 0x0200,
        };
        os2[62..64].copy_from_slice(&flags.to_be_bytes());
        tables.insert(*b"OS/2", os2);
        let mut name = Vec::new();
        name.extend(0_u16.to_be_bytes());
        name.extend(1_u16.to_be_bytes());
        name.extend(18_u16.to_be_bytes());
        let encoded = self
            .family
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect::<Vec<_>>();
        for value in [3, 1, 0x0409, 1, encoded.len() as u16, 0] {
            name.extend(value.to_be_bytes());
        }
        name.extend(encoded);
        tables.insert(*b"name", name);
        if !self.axes.is_empty() {
            let mut fvar = 0x0001_0000_u32.to_be_bytes().to_vec();
            for value in [
                16,
                2,
                self.axes.len() as u16,
                20,
                0,
                4 + 4 * self.axes.len() as u16,
            ] {
                fvar.extend(value.to_be_bytes());
            }
            for axis in &self.axes {
                fvar.extend(axis.tag);
                for value in [axis.minimum, axis.default, axis.maximum] {
                    fvar.extend(((value * 65536.0) as i32).to_be_bytes());
                }
                fvar.extend(0_u16.to_be_bytes());
                fvar.extend(256_u16.to_be_bytes());
            }
            tables.insert(*b"fvar", fvar);
        }
        let mut result = vec![0; 12 + 16 * tables.len()];
        result[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        result[4..6].copy_from_slice(&(tables.len() as u16).to_be_bytes());
        for (index, (tag, bytes)) in tables.into_iter().enumerate() {
            while !result.len().is_multiple_of(4) {
                result.push(0);
            }
            let offset = result.len() as u32;
            let start = 12 + index * 16;
            result[start..start + 4].copy_from_slice(&tag);
            result[start + 8..start + 12].copy_from_slice(&offset.to_be_bytes());
            result[start + 12..start + 16].copy_from_slice(&(bytes.len() as u32).to_be_bytes());
            result.extend(bytes);
        }
        result
    }

    pub fn collection(fonts: &[Self]) -> Vec<u8> {
        let mut result = vec![0; 12 + fonts.len() * 4];
        result[..4].copy_from_slice(b"ttcf");
        result[4..8].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
        result[8..12].copy_from_slice(&(fonts.len() as u32).to_be_bytes());
        for (index, font) in fonts.iter().enumerate() {
            while !result.len().is_multiple_of(4) {
                result.push(0);
            }
            let offset = result.len() as u32;
            result[12 + index * 4..16 + index * 4].copy_from_slice(&offset.to_be_bytes());
            let mut bytes = font.bytes();
            let tables = usize::from(u16::from_be_bytes([bytes[4], bytes[5]]));
            for table in 0..tables {
                let start = 20 + table * 16;
                let relative = u32::from_be_bytes([
                    bytes[start],
                    bytes[start + 1],
                    bytes[start + 2],
                    bytes[start + 3],
                ]);
                bytes[start..start + 4].copy_from_slice(&(relative + offset).to_be_bytes());
            }
            result.extend(bytes);
        }
        result
    }

    pub fn loaded(bytes: Vec<u8>) -> LoadedFont {
        let sha256: [u8; 32] = Sha256::digest(&bytes).into();
        let mut prefix = [0; 8];
        prefix.copy_from_slice(&sha256[..8]);
        LoadedFont {
            id: FontId(u64::from_le_bytes(prefix)),
            sha256,
            data: Arc::from(bytes),
        }
    }
}

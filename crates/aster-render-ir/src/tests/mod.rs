mod camera;
mod codec;
mod comparison;
mod encoded_texture;
mod frame_bundle;
mod frame_time;
mod frame_time_codec;
mod generator;
mod identity;
mod material;
mod media_resources;
mod resources;
mod root_scene;
mod scene;
mod schema_time;
mod temporal_pass;
mod temporal_text;
mod texture_pixels;

use crate::{
    DecodeLimits, FramePlanSliceV1, IrError, IrFixture, canonical::CanonicalJson, wire::WireHeader,
};

struct Fixture {
    metadata: FramePlanSliceV1,
    blobs: Vec<Vec<u8>>,
}

impl Fixture {
    fn new() -> Result<Self, IrError> {
        let (metadata, blobs) = IrFixture::parts()?;
        Ok(Self { metadata, blobs })
    }

    fn encode(&self) -> Result<Vec<u8>, IrError> {
        let blobs = self.blobs.iter().map(Vec::as_slice).collect::<Vec<_>>();
        crate::FplnCodec::encode(self.metadata.clone(), &blobs, &DecodeLimits::default())
    }

    fn unchecked_metadata(&self) -> Result<Vec<u8>, IrError> {
        Self::unchecked_json(&CanonicalJson::encode(&self.metadata)?, &self.blobs)
    }

    fn unchecked_json(json: &[u8], blobs: &[Vec<u8>]) -> Result<Vec<u8>, IrError> {
        let metadata_bytes = u32::try_from(json.len()).map_err(|_| IrError::ArithmeticOverflow)?;
        let blob_section_offset = WireHeader::align16(32 + metadata_bytes)?;
        let blob_bytes = blobs.iter().try_fold(0_u32, |sum, blob| {
            WireHeader::align16(
                sum + u32::try_from(blob.len()).map_err(|_| IrError::ArithmeticOverflow)?,
            )
        })?;
        let header = WireHeader {
            metadata_bytes,
            blob_count: blobs.len() as u32,
            blob_section_offset,
            container_bytes: blob_section_offset + blob_bytes,
        };
        let mut output = vec![0; header.container_bytes as usize];
        header.write(&mut output)?;
        output[32..32 + json.len()].copy_from_slice(json);
        let mut cursor = blob_section_offset;
        for blob in blobs {
            output[cursor as usize..cursor as usize + blob.len()].copy_from_slice(blob);
            cursor = WireHeader::align16(cursor + blob.len() as u32)?;
        }
        Ok(output)
    }
}

mod layer_effect;

mod effect_execution;

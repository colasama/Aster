use std::{mem::ManuallyDrop, ptr};

use aster_render_ir::ExportVideoConfig;
use windows::Win32::Media::MediaFoundation::*;

use crate::{EncodeError, EncodedPacket, timing::FrameClock};

pub(crate) struct MfPacket;

impl MfPacket {
    pub(crate) fn input(
        video: &ExportVideoConfig,
        frame: u64,
        nv12: &[u8],
    ) -> Result<IMFSample, EncodeError> {
        let length = u32::try_from(nv12.len())
            .map_err(|_| EncodeError::Invalid("NV12 sample exceeds platform limit".into()))?;
        let timing = FrameClock::at(video.frame_rate, frame)?;
        unsafe {
            let buffer = MFCreateMemoryBuffer(length)?;
            let mut data = ptr::null_mut();
            buffer.Lock(&mut data, None, None)?;
            std::slice::from_raw_parts_mut(data, nv12.len()).copy_from_slice(nv12);
            buffer.Unlock()?;
            buffer.SetCurrentLength(length)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(timing.timestamp_100ns)?;
            sample.SetSampleDuration(timing.duration_100ns)?;
            Ok(sample)
        }
    }

    pub(crate) fn output(
        transform: &IMFTransform,
        video: &ExportVideoConfig,
        frame: u64,
        max_bytes: u32,
    ) -> Result<EncodedPacket, EncodeError> {
        unsafe {
            let mut output = [MFT_OUTPUT_DATA_BUFFER::default()];
            let mut status = 0;
            let result = transform.ProcessOutput(0, &mut output, &mut status);
            let sample = ManuallyDrop::take(&mut output[0].pSample);
            drop(ManuallyDrop::take(&mut output[0].pEvents));
            result?;
            let sample = sample
                .ok_or_else(|| EncodeError::Platform("hardware output sample missing".into()))?;
            let mut metadata = FrameClock::at(video.frame_rate, frame)?;
            if sample.GetSampleTime()? != metadata.timestamp_100ns {
                return Err(EncodeError::Platform(
                    "hardware output timestamp is reordered or unexpected".into(),
                ));
            }
            let length = sample.GetTotalLength()?;
            if length < 5 || length > max_bytes {
                return Err(EncodeError::Platform(
                    "hardware output exceeds packet byte limit".into(),
                ));
            }
            // Check the total before asking Media Foundation to coalesce multiple buffers.
            let buffer = sample.ConvertToContiguousBuffer()?;
            let mut bytes = Vec::new();
            bytes
                .try_reserve_exact(length as usize)
                .map_err(|_| EncodeError::Platform("encoded packet allocation failed".into()))?;
            let mut data = ptr::null_mut();
            let mut actual = 0;
            buffer.Lock(&mut data, None, Some(&mut actual))?;
            if actual == length && !data.is_null() {
                bytes.extend_from_slice(std::slice::from_raw_parts(data, length as usize));
            }
            buffer.Unlock()?;
            if bytes.len() != length as usize
                || !(bytes.starts_with(&[0, 0, 1]) || bytes.starts_with(&[0, 0, 0, 1]))
            {
                return Err(EncodeError::Platform(
                    "hardware output is not bounded Annex-B".into(),
                ));
            }
            metadata.payload_bytes = length;
            Ok(EncodedPacket { metadata, bytes })
        }
    }
}

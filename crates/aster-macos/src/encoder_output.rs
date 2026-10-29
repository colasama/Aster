use crate::VideoEncoder;
use objc2_core_media::{CMSampleBuffer, CMVideoFormatDescriptionGetH264ParameterSetAtIndex};
use objc2_video_toolbox::VTEncodeInfoFlags;
use std::{
    ffi::c_void,
    ptr::{self, NonNull},
    sync::Mutex,
};

pub(crate) struct EncoderOutput {
    pub(crate) maximum: usize,
    pub(crate) packet: Result<Option<Vec<u8>>, String>,
}

impl EncoderOutput {
    pub(crate) unsafe extern "C-unwind" fn callback(
        context: *mut c_void,
        _: *mut c_void,
        status: i32,
        flags: VTEncodeInfoFlags,
        sample: *mut CMSampleBuffer,
    ) {
        // The session owns callback scheduling; VideoEncoder keeps this box alive until invalidate.
        let output = unsafe { &*context.cast::<Mutex<Self>>() };
        if let Ok(mut output) = output.lock() {
            if !matches!(output.packet, Ok(None)) {
                output.packet = Err("unexpected duplicate VideoToolbox output".into());
                return;
            }
            output.packet = if status != 0 || flags.contains(VTEncodeInfoFlags::FrameDropped) {
                Err(format!(
                    "VideoToolbox output failed or dropped a frame: {status}"
                ))
            } else if let Some(sample) = unsafe { sample.as_ref() } {
                output.read_sample(sample).map(Some)
            } else {
                Err("VideoToolbox returned an empty sample".into())
            };
        }
    }

    fn read_sample(&self, sample: &CMSampleBuffer) -> Result<Vec<u8>, String> {
        unsafe {
            if !sample.data_is_ready() {
                return Err("VideoToolbox sample is not ready".into());
            }
            let format = sample.format_description().ok_or("missing H264 format")?;
            let block = sample.data_buffer().ok_or("missing H264 data")?;
            let length = block.data_length();
            if length == 0 || length > self.maximum {
                return Err("H264 packet exceeds byte budget".into());
            }
            let mut bytes = vec![0; length];
            VideoEncoder::check(
                block.copy_data_bytes(
                    0,
                    length,
                    NonNull::new(bytes.as_mut_ptr())
                        .ok_or("empty H264 packet")?
                        .cast(),
                ),
                "copy compressed packet",
            )?;
            let mut parameters = Vec::new();
            let mut count = 0;
            let mut nal_length = 0;
            VideoEncoder::check(
                CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    &format,
                    0,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut count,
                    &mut nal_length,
                ),
                "read H264 format",
            )?;
            if nal_length != 4 || count > 16 {
                return Err("unsupported H264 format".into());
            }
            for index in 0..count {
                let mut pointer = ptr::null();
                let mut length = 0;
                VideoEncoder::check(
                    CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                        &format,
                        index,
                        &mut pointer,
                        &mut length,
                        ptr::null_mut(),
                        ptr::null_mut(),
                    ),
                    "read H264 parameter set",
                )?;
                if pointer.is_null() || length == 0 || length > self.maximum {
                    return Err("invalid H264 parameter set".into());
                }
                self.append(&mut parameters, std::slice::from_raw_parts(pointer, length))?;
            }
            self.annex_b(&bytes, &parameters)
        }
    }

    fn append(&self, packet: &mut Vec<u8>, bytes: &[u8]) -> Result<(), String> {
        if bytes
            .len()
            .checked_add(4)
            .is_none_or(|length| length > self.maximum.saturating_sub(packet.len()))
        {
            return Err("H264 packet exceeds byte budget".into());
        }
        packet.extend_from_slice(&[0, 0, 0, 1]);
        packet.extend_from_slice(bytes);
        Ok(())
    }

    fn annex_b(&self, bytes: &[u8], parameters: &[u8]) -> Result<Vec<u8>, String> {
        let mut packet = Vec::new();
        let mut remaining = bytes;
        let mut keyframe = false;
        while !remaining.is_empty() {
            let header: [u8; 4] = remaining
                .get(..4)
                .ok_or("truncated H264 NAL length")?
                .try_into()
                .map_err(|_| "invalid H264 NAL length")?;
            let length = u32::from_be_bytes(header) as usize;
            remaining = &remaining[4..];
            let nal = remaining
                .get(..length)
                .filter(|nal| !nal.is_empty())
                .ok_or("invalid H264 NAL extent")?;
            keyframe |= nal[0] & 0x1f == 5;
            self.append(&mut packet, nal)?;
            remaining = &remaining[length..];
        }
        if keyframe {
            if parameters.len() > self.maximum.saturating_sub(packet.len()) {
                return Err("H264 keyframe exceeds byte budget".into());
            }
            let mut combined = parameters.to_vec();
            combined.extend_from_slice(&packet);
            packet = combined;
        }
        Ok(packet)
    }
}

#[cfg(test)]
mod tests {
    use super::EncoderOutput;

    #[test]
    fn bounds_and_parameter_sets_follow_h264_access_units() -> Result<(), String> {
        let output = EncoderOutput {
            maximum: 16,
            packet: Ok(None),
        };
        let parameters = [0, 0, 0, 1, 0x67];
        assert_eq!(
            output.annex_b(&[0, 0, 0, 1, 0x65], &parameters)?,
            [0, 0, 0, 1, 0x67, 0, 0, 0, 1, 0x65]
        );
        assert_eq!(
            output.annex_b(&[0, 0, 0, 1, 0x41], &parameters)?,
            [0, 0, 0, 1, 0x41]
        );
        assert!(output.annex_b(&[0, 0, 0], &[]).is_err());
        assert!(output.annex_b(&[0, 0, 0, 2, 0x65], &[]).is_err());
        assert!(output.annex_b(&[0, 0, 0, 0], &[]).is_err());
        assert!(output.annex_b(&[0, 0, 0, 1, 0x65], &[0; 12]).is_err());
        Ok(())
    }
}

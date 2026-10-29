use crate::{Surface, encoder_output::EncoderOutput};
use objc2_core_foundation::{CFBoolean, CFDictionary, CFNumber, CFRetained, CFType};
use objc2_core_media::{CMTime, kCMVideoCodecType_H264};
use objc2_core_video::*;
use objc2_video_toolbox::*;
use std::{
    ffi::c_void,
    ptr::{self, NonNull},
    sync::Mutex,
};

/// Hardware-only VideoToolbox session with one bounded, fully drained input at a time.
pub struct VideoEncoder {
    session: CFRetained<VTCompressionSession>,
    // The stable callback address outlives session invalidation, including error paths.
    output: Box<Mutex<EncoderOutput>>,
    size: [u32; 2],
    rate: [u32; 2],
}

impl VideoEncoder {
    pub fn new(
        size: [u32; 2],
        rate: [u32; 2],
        bitrate: u32,
        maximum: usize,
    ) -> Result<Self, String> {
        Surface::allocation_bytes(size[0], size[1])?;
        if rate[0] == 0
            || rate[0] > i32::MAX as u32
            || rate[1] == 0
            || bitrate == 0
            || maximum == 0
            || maximum > 67_108_864
        {
            return Err("invalid VideoToolbox limits".into());
        }
        let mut output = Box::new(Mutex::new(EncoderOutput {
            maximum,
            packet: Ok(None),
        }));
        unsafe {
            let spec = CFDictionary::from_slices(
                &[kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder],
                &[CFBoolean::new(true)],
            );
            let pixel_format = CFNumber::new_i64(kCVPixelFormatType_32BGRA as i64);
            let width = CFNumber::new_i64(size[0] as i64);
            let height = CFNumber::new_i64(size[1] as i64);
            let empty = CFDictionary::<CFType, CFType>::empty();
            let attributes = CFDictionary::from_slices(
                &[
                    kCVPixelBufferPixelFormatTypeKey,
                    kCVPixelBufferWidthKey,
                    kCVPixelBufferHeightKey,
                    kCVPixelBufferIOSurfacePropertiesKey,
                ],
                &[
                    pixel_format.as_ref(),
                    width.as_ref(),
                    height.as_ref(),
                    empty.as_ref(),
                ] as &[&CFType],
            );
            let mut raw = ptr::null_mut();
            Self::check(
                VTCompressionSession::create(
                    None,
                    size[0] as i32,
                    size[1] as i32,
                    kCMVideoCodecType_H264,
                    Some(spec.as_opaque()),
                    Some(attributes.as_opaque()),
                    None,
                    Some(EncoderOutput::callback),
                    (&mut *output as *mut Mutex<EncoderOutput>).cast(),
                    NonNull::from(&mut raw),
                ),
                "create hardware encoder",
            )?;
            let session =
                CFRetained::from_raw(NonNull::new(raw).ok_or("missing VideoToolbox session")?);
            let encoder = Self {
                session,
                output,
                size,
                rate,
            };
            let bitrate = CFNumber::new_i64(bitrate as i64);
            let fps = CFNumber::new_f64(f64::from(rate[0]) / f64::from(rate[1]));
            let properties = CFDictionary::from_slices(
                &[
                    kVTCompressionPropertyKey_AverageBitRate,
                    kVTCompressionPropertyKey_ExpectedFrameRate,
                    kVTCompressionPropertyKey_AllowFrameReordering,
                    kVTCompressionPropertyKey_RealTime,
                    kVTCompressionPropertyKey_ProfileLevel,
                    kVTCompressionPropertyKey_ColorPrimaries,
                    kVTCompressionPropertyKey_TransferFunction,
                    kVTCompressionPropertyKey_YCbCrMatrix,
                ],
                &[
                    bitrate.as_ref(),
                    fps.as_ref(),
                    CFBoolean::new(false).as_ref(),
                    CFBoolean::new(false).as_ref(),
                    kVTProfileLevel_H264_High_AutoLevel.as_ref(),
                    kCVImageBufferColorPrimaries_ITU_R_709_2.as_ref(),
                    kCVImageBufferTransferFunction_ITU_R_709_2.as_ref(),
                    kCVImageBufferYCbCrMatrix_ITU_R_709_2.as_ref(),
                ] as &[&CFType],
            );
            Self::check(
                VTSessionSetProperties(encoder.session.as_ref(), properties.as_opaque()),
                "configure encoder",
            )?;
            Self::check(
                encoder.session.prepare_to_encode_frames(),
                "prepare encoder",
            )?;
            let mut hardware: *mut CFType = ptr::null_mut();
            Self::check(
                VTSessionCopyProperty(
                    encoder.session.as_ref(),
                    kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder,
                    None,
                    (&mut hardware as *mut *mut CFType).cast::<c_void>(),
                ),
                "verify hardware encoder",
            )?;
            let hardware = CFRetained::from_raw(
                NonNull::new(hardware).ok_or("missing hardware encoder property")?,
            );
            if hardware
                .downcast_ref::<CFBoolean>()
                .is_none_or(|value| !value.as_bool())
            {
                return Err("VideoToolbox hardware encoder is unavailable".into());
            }
            Ok(encoder)
        }
    }

    pub fn push(&mut self, surface: &Surface, frame: u64) -> Result<Vec<u8>, String> {
        if [surface.width, surface.height] != self.size
            || frame > i64::MAX as u64 / u64::from(self.rate[1])
        {
            return Err("VideoToolbox input extent or clock differs".into());
        }
        self.output
            .lock()
            .map_err(|_| "poisoned encoder output")?
            .packet = Ok(None);
        unsafe {
            let mut pixel = ptr::null_mut();
            Self::check(
                CVPixelBufferCreateWithIOSurface(
                    None,
                    &surface.raw,
                    None,
                    NonNull::from(&mut pixel),
                ),
                "wrap IOSurface",
            )?;
            let pixel = CFRetained::from_raw(
                NonNull::new(pixel).ok_or("missing VideoToolbox pixel buffer")?,
            );
            let time = CMTime::new(
                (frame * u64::from(self.rate[1])) as i64,
                self.rate[0] as i32,
            );
            let duration = CMTime::new(i64::from(self.rate[1]), self.rate[0] as i32);
            Self::check(
                self.session.encode_frame(
                    &pixel,
                    time,
                    duration,
                    None,
                    ptr::null_mut(),
                    ptr::null_mut(),
                ),
                "encode frame",
            )?;
            Self::check(self.session.complete_frames(time), "drain frame")?;
        }
        let mut output = self.output.lock().map_err(|_| "poisoned encoder output")?;
        std::mem::replace(&mut output.packet, Ok(None))?
            .ok_or_else(|| "VideoToolbox produced no packet".into())
    }

    pub(crate) fn check(status: i32, operation: &str) -> Result<(), String> {
        if status != 0 {
            return Err(format!("VideoToolbox {operation} failed: {status}"));
        }
        Ok(())
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        // Invalidate synchronously stops callbacks before the boxed callback context is dropped.
        unsafe {
            self.session.invalidate();
        }
    }
}

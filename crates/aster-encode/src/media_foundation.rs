use std::{marker::PhantomData, ptr, rc::Rc};

use aster_render_ir::{AdapterLuid, ExportVideoConfig};
use windows::{
    Win32::{Media::MediaFoundation::*, System::Com::*},
    core::{Interface, PWSTR},
};

use crate::{EncodeError, EncoderProbeLimits, HardwareEncoderCandidate, HardwareEncoderProbe};

pub(crate) struct MfRuntime {
    _thread: PhantomData<Rc<()>>,
}

impl Drop for MfRuntime {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}

struct Activations {
    array: *mut Option<IMFActivate>,
    count: usize,
}
impl Drop for Activations {
    fn drop(&mut self) {
        if !self.array.is_null() {
            unsafe {
                for item in std::slice::from_raw_parts_mut(self.array, self.count) {
                    drop(item.take());
                }
                CoTaskMemFree(Some(self.array.cast()));
            }
        }
    }
}

pub(crate) struct ActiveTransform {
    activation: IMFActivate,
    pub(crate) transform: IMFTransform,
    pub(crate) probe_inputs: Vec<IMFSample>,
}
impl Drop for ActiveTransform {
    fn drop(&mut self) {
        unsafe {
            if let Ok(shutdown) = self.transform.cast::<IMFShutdown>() {
                let _ = shutdown.Shutdown();
            }
            let _ = self.activation.ShutdownObject();
        }
    }
}

impl ActiveTransform {
    pub(crate) fn configure(
        activation: &IMFActivate,
        video: &ExportVideoConfig,
        manager: Option<&IMFDXGIDeviceManager>,
        limits: &EncoderProbeLimits,
    ) -> windows::core::Result<Self> {
        unsafe {
            let active = Self {
                activation: activation.clone(),
                transform: activation.ActivateObject()?,
                probe_inputs: Vec::new(),
            };
            let attributes = active.transform.GetAttributes()?;
            if attributes.GetUINT32(&MF_TRANSFORM_ASYNC)? != 1 {
                return Err(windows::core::Error::from_hresult(
                    windows::Win32::Foundation::E_NOINTERFACE,
                ));
            }
            attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
            attributes.SetUINT32(&MF_LOW_LATENCY, 1)?;
            let quality = crate::mf_quality::MfQuality::new(video, limits);
            quality.apply(&active.transform)?;
            if let Some(manager) = manager {
                if attributes.GetUINT32(&MF_SA_D3D11_AWARE)? != 1 {
                    return Err(windows::core::Error::from_hresult(
                        windows::Win32::Foundation::E_NOINTERFACE,
                    ));
                }
                active
                    .transform
                    .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
            }
            active
                .transform
                .SetOutputType(0, &Self::media_type(video, true)?, 0)?;
            active
                .transform
                .SetInputType(0, &Self::media_type(video, false)?, 0)?;
            quality.verify(&active.transform)?;
            Ok(active)
        }
    }

    fn media_type(video: &ExportVideoConfig, encoded: bool) -> windows::core::Result<IMFMediaType> {
        unsafe {
            let media = MFCreateMediaType()?;
            media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
            media.SetGUID(
                &MF_MT_SUBTYPE,
                if encoded {
                    &MFVideoFormat_H264
                } else {
                    &MFVideoFormat_NV12
                },
            )?;
            media.SetUINT64(
                &MF_MT_FRAME_SIZE,
                (u64::from(video.size.width) << 32) | u64::from(video.size.height),
            )?;
            media.SetUINT64(
                &MF_MT_FRAME_RATE,
                (u64::from(video.frame_rate.numerator) << 32)
                    | u64::from(video.frame_rate.denominator),
            )?;
            media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1_u64 << 32) | 1)?;
            media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
            for (key, value) in [
                (MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0),
                (MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0),
                (MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0),
                (MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0),
            ] {
                media.SetUINT32(&key, value as u32)?;
            }
            if encoded {
                media.SetUINT32(&MF_MT_AVG_BITRATE, video.bitrate_bps)?;
                media.SetUINT32(&MF_MT_MPEG2_PROFILE, 66)?;
            }
            Ok(media)
        }
    }
}

impl MfRuntime {
    pub(crate) fn start() -> windows::core::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error);
            }
        }
        Ok(Self {
            _thread: PhantomData,
        })
    }

    pub(crate) fn probe(
        luid: AdapterLuid,
        video: &ExportVideoConfig,
        limits: &EncoderProbeLimits,
    ) -> Result<HardwareEncoderProbe, EncodeError> {
        let result = Self::inspect(luid, video, limits);
        result.map_err(|error| EncodeError::Platform(error.to_string()))
    }

    pub(crate) fn encoders(
        &self,
        luid: AdapterLuid,
        limits: &EncoderProbeLimits,
    ) -> Result<Vec<IMFActivate>, Box<dyn std::error::Error>> {
        unsafe {
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 1)?;
            let attributes = attributes.ok_or("missing MF attribute store")?;
            let mut bytes = luid.low.to_le_bytes().to_vec();
            bytes.extend(luid.high.to_le_bytes());
            attributes.SetBlob(&MFT_ENUM_ADAPTER_LUID, &bytes)?;
            let output = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
            };
            let mut array = ptr::null_mut();
            let mut count = 0;
            MFTEnum2(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                None,
                Some(&output),
                &attributes,
                &mut array,
                &mut count,
            )?;
            let activations = Activations {
                array,
                count: count as usize,
            };
            if count as usize > limits.max_hardware_encoders || (count > 0 && array.is_null()) {
                return Err("hardware encoder enumeration exceeds limits".into());
            }
            let mut candidates = Vec::with_capacity(activations.count);
            if activations.count > 0 {
                for activation in
                    std::slice::from_raw_parts_mut(activations.array, activations.count)
                {
                    candidates.push(activation.take().ok_or("missing hardware activation")?);
                }
            }
            Ok(candidates)
        }
    }

    pub(crate) fn name(activation: &IMFActivate) -> Result<String, Box<dyn std::error::Error>> {
        unsafe {
            let mut name = PWSTR::null();
            let mut length = 0;
            activation.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut name, &mut length)?;
            let text: Result<String, Box<dyn std::error::Error>> = if length <= 16_384 {
                name.to_string().map_err(Into::into)
            } else {
                Err("hardware encoder name exceeds limit".into())
            };
            CoTaskMemFree(Some(name.0.cast()));
            text
        }
    }

    fn inspect(
        luid: AdapterLuid,
        video: &ExportVideoConfig,
        limits: &EncoderProbeLimits,
    ) -> Result<HardwareEncoderProbe, Box<dyn std::error::Error>> {
        let runtime = Self::start()?;
        let mut candidates = Vec::new();
        for activation in runtime.encoders(luid, limits)? {
            let mut candidate = HardwareEncoderCandidate {
                name: Self::name(&activation)?,
                configuration_accepted: false,
                reason: None,
                encoded_proof: None,
            };
            match ActiveTransform::configure(&activation, video, None, limits) {
                Ok(mut active) => {
                    candidate.configuration_accepted = true;
                    match crate::probe_stream::ProbeStream::verify(&mut active, video, limits, None)
                    {
                        Ok(proof) => candidate.encoded_proof = Some(proof),
                        Err(error) => candidate.reason = Some(error.to_string()),
                    }
                }
                Err(error) => candidate.reason = Some(error.to_string()),
            }
            candidates.push(candidate);
        }
        let test_frame_verified = candidates
            .iter()
            .any(|candidate| candidate.encoded_proof.is_some());
        Ok(HardwareEncoderProbe {
            adapter_luid: luid,
            hardware_only: true,
            candidates,
            test_frame_verified,
        })
    }
}

use std::{
    os::windows::io::{AsHandle, AsRawHandle},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use aster_render_ir::{AdapterLuid, ExportVideoConfig};
use windows::{
    Win32::{
        Foundation::{E_NOTIMPL, HANDLE, HMODULE, LUID},
        Graphics::{
            Direct3D::*,
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
        Media::MediaFoundation::*,
    },
    core::{Interface, Ref, implement},
};

use crate::{EncodeError, timing::FrameClock};

pub(crate) struct GpuInputDevice {
    pub(crate) manager: IMFDXGIDeviceManager,
    device: ID3D11Device,
}

pub(crate) struct GpuInputLease {
    // Retained until both the matching output and the MF sample release are observed.
    pub(crate) _owner: Arc<dyn Send + Sync>,
    pub(crate) released: Arc<AtomicBool>,
}

#[implement(IMFAsyncCallback)]
struct SampleRelease {
    owner: Mutex<Option<Arc<dyn Send + Sync>>>,
    released: Arc<AtomicBool>,
}

impl IMFAsyncCallback_Impl for SampleRelease_Impl {
    fn GetParameters(&self, _flags: *mut u32, _queue: *mut u32) -> windows::core::Result<()> {
        Err(windows::core::Error::from_hresult(E_NOTIMPL))
    }

    fn Invoke(&self, _result: Ref<IMFAsyncResult>) -> windows::core::Result<()> {
        let mut owner = self
            .owner
            .lock()
            .map_err(|_| windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL))?;
        owner.take();
        self.released.store(true, Ordering::Release);
        Ok(())
    }
}

impl GpuInputDevice {
    pub(crate) fn new(luid: AdapterLuid) -> Result<Self, EncodeError> {
        unsafe {
            let factory: IDXGIFactory4 = CreateDXGIFactory1()?;
            let adapter: IDXGIAdapter = factory.EnumAdapterByLuid(LUID {
                LowPart: luid.low,
                HighPart: luid.high,
            })?;
            let description = adapter.GetDesc()?;
            let version = adapter.CheckInterfaceSupport(&IDXGIDevice::IID)? as u64;
            // This driver faults inside its adapter-selection trace before the first GPU
            // sample. Reject it before activation so callers can use hardware memory input.
            if description.VendorId == 0x1002
                && description.DeviceId == 0x1900
                && version == (32_u64 << 48) | (21030_u64 << 16) | 2001
            {
                return Err(EncodeError::Unsupported(
                    "AMD Radeon 780M driver 32.0.21030.2001 has an unsafe shared-input initialization; use native NV12 readback with hardware encoding".into(),
                ));
            }
            let mut device = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )?;
            let device = device
                .ok_or_else(|| EncodeError::Platform("encoder D3D11 device missing".into()))?;
            let multithread: ID3D11Multithread = device.GetImmediateContext()?.cast()?;
            let _ = multithread.SetMultithreadProtected(true);
            let mut token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager
                .ok_or_else(|| EncodeError::Platform("encoder DXGI manager missing".into()))?;
            manager.ResetDevice(&device, token)?;
            Ok(Self { manager, device })
        }
    }

    pub(crate) fn shared_sample<F: AsHandle + Send + Sync + 'static>(
        &self,
        video: &ExportVideoConfig,
        index: u64,
        frame: F,
    ) -> Result<(IMFSample, GpuInputLease), EncodeError> {
        unsafe {
            let device: ID3D11Device1 = self.device.cast()?;
            let texture: ID3D11Texture2D =
                device.OpenSharedResource1(HANDLE(frame.as_handle().as_raw_handle()))?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            if desc.Format != DXGI_FORMAT_NV12
                || desc.Width != video.size.width
                || desc.Height != video.size.height
                || desc.MipLevels != 1
                || desc.ArraySize != 1
                || desc.SampleDesc.Count != 1
            {
                return Err(EncodeError::Invalid(
                    "shared encoder texture descriptor".into(),
                ));
            }
            let tracked = MFCreateTrackedSample()?;
            let sample: IMFSample = tracked.cast()?;
            Self::populate(&sample, &texture, video, index)?;
            let owner: Arc<dyn Send + Sync> = Arc::new(frame);
            let released = Arc::new(AtomicBool::new(false));
            let callback: IMFAsyncCallback = SampleRelease {
                owner: Mutex::new(Some(Arc::clone(&owner))),
                released: Arc::clone(&released),
            }
            .into();
            tracked.SetAllocator(&callback, None)?;
            Ok((
                sample,
                GpuInputLease {
                    _owner: owner,
                    released,
                },
            ))
        }
    }

    pub(crate) fn probe_sample(
        &self,
        video: &ExportVideoConfig,
        index: u32,
    ) -> Result<IMFSample, EncodeError> {
        let pixels = (video.size.width * video.size.height) as usize;
        let mut bytes = vec![128; pixels * 3 / 2];
        for (pixel, value) in bytes[..pixels].iter_mut().enumerate() {
            *value = 16 + ((pixel as u32 % video.size.width + index * 11) % 220) as u8;
        }
        unsafe {
            let mut texture = None;
            self.device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: video.size.width,
                    Height: video.size.height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                    ..Default::default()
                },
                Some(&D3D11_SUBRESOURCE_DATA {
                    pSysMem: bytes.as_ptr().cast(),
                    SysMemPitch: video.size.width,
                    SysMemSlicePitch: bytes.len() as u32,
                }),
                Some(&mut texture),
            )?;
            let texture = texture
                .ok_or_else(|| EncodeError::Platform("GPU encoder probe texture missing".into()))?;
            let sample = MFCreateSample()?;
            Self::populate(&sample, &texture, video, u64::from(index))?;
            Ok(sample)
        }
    }

    fn populate(
        sample: &IMFSample,
        texture: &ID3D11Texture2D,
        video: &ExportVideoConfig,
        index: u64,
    ) -> Result<(), EncodeError> {
        let timing = FrameClock::at(video.frame_rate, index)?;
        unsafe {
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(timing.timestamp_100ns)?;
            sample.SetSampleDuration(timing.duration_100ns)?;
            if index == 0 {
                sample.SetUINT32(&MFSampleExtension_Discontinuity, 1)?;
            }
        }
        Ok(())
    }
}

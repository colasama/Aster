use windows::Win32::{
    Foundation::RPC_E_CHANGED_MODE,
    Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_VendorMicrosoft,
        GUID_WICPixelFormat32bppRGBA, IWICImagingFactory, IWICPalette, WICBitmapDitherTypeNone,
        WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
    },
    System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    },
};

use crate::MediaError;

struct ComApartment {
    owned: bool,
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.owned {
            // All WIC interfaces are dropped before balancing this thread's successful initialization.
            unsafe {
                CoUninitialize();
            }
        }
    }
}

pub(crate) struct WindowsJpeg;

impl WindowsJpeg {
    pub fn decode(encoded: &[u8], size: (u32, u32)) -> Result<Vec<u8>, MediaError> {
        // COM initialization is balanced for S_OK and S_FALSE; an existing STA is borrowed.
        let status = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let owned = if status == RPC_E_CHANGED_MODE {
            false
        } else {
            status
                .ok()
                .map_err(|e| MediaError::Unsupported(format!("JPEG COM initialization: {e}")))?;
            true
        };
        let _apartment = ComApartment { owned };
        Self::decode_initialized(encoded, size)
            .map_err(|e| MediaError::Unsupported(format!("Windows JPEG decode: {e}")))
    }

    fn decode_initialized(encoded: &[u8], size: (u32, u32)) -> windows::core::Result<Vec<u8>> {
        // The caller validates encoded and decoded bounds before this method. The owned slice
        // outlives its memory stream and every decoder/converter; no filename or color transform is used.
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = factory.CreateStream()?;
            stream.InitializeFromMemory(encoded)?;
            let decoder =
                factory.CreateDecoder(&GUID_ContainerFormatJpeg, &GUID_VendorMicrosoft)?;
            decoder.Initialize(&stream, WICDecodeMetadataCacheOnDemand)?;
            let frame = decoder.GetFrame(0)?;
            let mut width = 0;
            let mut height = 0;
            frame.GetSize(&mut width, &mut height)?;
            if (width, height) != size {
                return Err(windows::core::Error::new(
                    windows::Win32::Foundation::E_INVALIDARG,
                    "JPEG decoded extent differs",
                ));
            }
            let converter = factory.CreateFormatConverter()?;
            converter.Initialize(
                &frame,
                &GUID_WICPixelFormat32bppRGBA,
                WICBitmapDitherTypeNone,
                None::<&IWICPalette>,
                0.0,
                WICBitmapPaletteTypeCustom,
            )?;
            let mut pixels = vec![0; width as usize * height as usize * 4];
            converter.CopyPixels(std::ptr::null(), width * 4, &mut pixels)?;
            Ok(pixels)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn borrowed_sta_survives_decoder_failure() -> windows::core::Result<()> {
        use windows::Win32::System::Com::{
            APTTYPE, APTTYPEQUALIFIER, COINIT_APARTMENTTHREADED, CoGetApartmentType,
        };
        // A dedicated test thread begins with no COM apartment. The scope balances its own initialization.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        }
        let _apartment = ComApartment { owned: true };
        assert!(WindowsJpeg::decode(b"invalid", (1, 1)).is_err());
        let mut kind = APTTYPE::default();
        let mut qualifier = APTTYPEQUALIFIER::default();
        // Failure paths must not uninitialize the caller's borrowed apartment.
        unsafe {
            CoGetApartmentType(&mut kind, &mut qualifier)?;
        }
        Ok(())
    }
}

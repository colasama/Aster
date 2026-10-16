use windows::Win32::{
    Foundation::RPC_E_CHANGED_MODE,
    Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatJpeg, GUID_ContainerFormatPng,
        GUID_VendorMicrosoft, GUID_WICPixelFormat32bppRGBA, IWICImagingFactory, IWICPalette,
        WICBitmapDitherTypeNone, WICBitmapPaletteTypeCustom, WICDecodeMetadataCacheOnDemand,
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

pub(crate) struct WindowsImage;

impl WindowsImage {
    pub fn decode(encoded: &[u8], size: (u32, u32)) -> Result<Vec<u8>, MediaError> {
        let container = match aster_video::StillEncoding::detect(encoded)? {
            aster_video::StillEncoding::Png => GUID_ContainerFormatPng,
            aster_video::StillEncoding::Jpeg => GUID_ContainerFormatJpeg,
            aster_video::StillEncoding::Webp => {
                return Err(MediaError::Unsupported("WIC WebP route".into()));
            }
        };
        // COM initialization is balanced for S_OK and S_FALSE; an existing STA is borrowed.
        let status = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let owned = if status == RPC_E_CHANGED_MODE {
            false
        } else {
            status
                .ok()
                .map_err(|e| MediaError::Unsupported(format!("image COM initialization: {e}")))?;
            true
        };
        let _apartment = ComApartment { owned };
        Self::decode_initialized(encoded, size, &container)
            .map_err(|e| MediaError::Unsupported(format!("Windows image decode: {e}")))
    }

    fn decode_initialized(
        encoded: &[u8],
        size: (u32, u32),
        container: &windows::core::GUID,
    ) -> windows::core::Result<Vec<u8>> {
        // The caller validates encoded and decoded bounds before this method. The owned slice
        // outlives its memory stream and every decoder/converter; no filename or color transform is used.
        unsafe {
            let factory: IWICImagingFactory =
                CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = factory.CreateStream()?;
            stream.InitializeFromMemory(encoded)?;
            let decoder = factory.CreateDecoder(container, &GUID_VendorMicrosoft)?;
            decoder.Initialize(&stream, WICDecodeMetadataCacheOnDemand)?;
            let frame = decoder.GetFrame(0)?;
            let mut width = 0;
            let mut height = 0;
            frame.GetSize(&mut width, &mut height)?;
            if (width, height) != size {
                return Err(windows::core::Error::new(
                    windows::Win32::Foundation::E_INVALIDARG,
                    "image decoded extent differs",
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
    use base64::Engine;

    #[test]
    fn png_preserves_straight_rgba_and_checks_extent() -> Result<(), Box<dyn std::error::Error>> {
        let encoded = base64::engine::general_purpose::STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAI0lEQVR4nGPgEpH7/yuVtyFZ8TIjg/v0Vwx3KjjrGf4z/AcAesUKIlXo/E4AAAAASUVORK5CYII=",
        )?;
        assert_eq!(
            WindowsImage::decode(&encoded, (3, 2))?,
            [
                10, 20, 30, 255, 250, 101, 13, 128, 99, 33, 211, 1, 71, 151, 234, 0, 220, 120, 9,
                127, 0, 255, 0, 255,
            ]
        );
        assert!(WindowsImage::decode(&encoded, (2, 3)).is_err());
        assert!(WindowsImage::decode(&encoded[..40], (3, 2)).is_err());
        Ok(())
    }

    #[test]
    #[ignore = "requires an explicit PNG corpus and packaged FFmpeg"]
    fn png_corpus_matches_ffmpeg_exactly() -> Result<(), Box<dyn std::error::Error>> {
        #[derive(serde::Deserialize)]
        struct Input {
            path: std::path::PathBuf,
            width: u32,
            height: u32,
        }
        let inputs: Vec<Input> = serde_json::from_slice(&std::fs::read(
            std::env::var_os("ASTER_PNG_PARITY_INPUTS").ok_or("PNG input manifest absent")?,
        )?)?;
        assert!(!inputs.is_empty());
        let ffmpeg = aster_video::FfmpegBackend::new(
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../build/ffmpeg/ffmpeg.exe"),
        );
        let cancellation = aster_video::CancellationToken::default();
        for input in inputs {
            let encoded = std::fs::read(input.path)?;
            let size = (input.width, input.height);
            let candidate = WindowsImage::decode(&encoded, size)?;
            let reference = ffmpeg.decode_still_rgba(encoded.into(), size, &cancellation)?;
            assert_eq!(candidate.len(), reference.len());
            assert!(
                candidate == reference,
                "WIC and FFmpeg PNG code values differ"
            );
        }
        Ok(())
    }

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
        assert!(WindowsImage::decode(&[0xff, 0xd8, 0xff, 0xd9], (1, 1)).is_err());
        let mut kind = APTTYPE::default();
        let mut qualifier = APTTYPEQUALIFIER::default();
        // Failure paths must not uninitialize the caller's borrowed apartment.
        unsafe {
            CoGetApartmentType(&mut kind, &mut qualifier)?;
        }
        Ok(())
    }
}

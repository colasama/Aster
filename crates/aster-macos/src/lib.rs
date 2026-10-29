#![cfg(target_os = "macos")]

mod encoder;
mod encoder_output;
#[cfg(feature = "node-addon")]
mod node_addon;
mod transport;

pub use encoder::VideoEncoder;
use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_core_foundation::{CFDictionary, CFNumber, CFRetained};
use objc2_io_surface::*;
use objc2_metal::{
    MTLDevice, MTLPixelFormat, MTLStorageMode, MTLTexture, MTLTextureDescriptor, MTLTextureUsage,
};

/// Retained, non-global IOSurface. Pixel access belongs to Metal and VideoToolbox.
pub struct Surface {
    raw: CFRetained<IOSurfaceRef>,
    width: u32,
    height: u32,
}

// IOSurface reference counting is thread safe; this wrapper exposes no CPU pixel access.
unsafe impl Send for Surface {}
unsafe impl Sync for Surface {}

impl Surface {
    pub fn allocation_bytes(width: u32, height: u32) -> Result<u64, String> {
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err("invalid IOSurface extent".into());
        }
        Ok(unsafe {
            IOSurfaceRef::align_property(
                kIOSurfaceAllocSize,
                IOSurfaceRef::align_property(kIOSurfaceBytesPerRow, width as usize * 4)
                    * height as usize,
            )
        } as u64)
    }

    pub fn new(width: u32, height: u32) -> Result<Self, String> {
        let allocation = Self::allocation_bytes(width, height)?;
        let raw = unsafe {
            let values = [
                width as i64,
                height as i64,
                4,
                i64::from(u32::from_be_bytes(*b"BGRA")),
                IOSurfaceRef::align_property(kIOSurfaceBytesPerRow, width as usize * 4) as i64,
                allocation as i64,
            ]
            .map(CFNumber::new_i64);
            let properties = CFDictionary::from_slices(
                &[
                    kIOSurfaceWidth,
                    kIOSurfaceHeight,
                    kIOSurfaceBytesPerElement,
                    kIOSurfacePixelFormat,
                    kIOSurfaceBytesPerRow,
                    kIOSurfaceAllocSize,
                ],
                &values.iter().map(|value| &**value).collect::<Vec<_>>(),
            );
            IOSurfaceRef::new(properties.as_opaque()).ok_or("IOSurface allocation failed")?
        };
        Ok(Self { raw, width, height })
    }

    pub fn metal_texture(
        &self,
        device: &ProtocolObject<dyn MTLDevice>,
    ) -> Result<Retained<ProtocolObject<dyn MTLTexture>>, String> {
        // The dimensions and BGRA format are validated by Surface::new.
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                self.width as usize,
                self.height as usize,
                false,
            )
        };
        descriptor.setStorageMode(MTLStorageMode::Shared);
        descriptor.setUsage(MTLTextureUsage::ShaderRead | MTLTextureUsage::RenderTarget);
        device
            .newTextureWithDescriptor_iosurface_plane(&descriptor, &self.raw, 0)
            .ok_or_else(|| "Metal IOSurface texture creation failed".into())
    }

    pub fn send(&self, service: &str, sequence: u64) -> Result<(), String> {
        transport::SurfaceMessage::send(&self.raw, service, sequence)
    }
}

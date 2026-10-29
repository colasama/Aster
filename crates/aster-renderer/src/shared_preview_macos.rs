use crate::RenderError;
use aster_macos::Surface;
use aster_render_ir::Extent2d;
use objc2_metal::MTLTextureType;
use std::sync::Arc;

pub struct SharedPreviewFrame {
    pub(crate) target: Arc<SharedPreviewTarget>,
}

impl SharedPreviewFrame {
    pub fn size(&self) -> Extent2d {
        self.target.size
    }

    pub fn surface(&self) -> &Surface {
        &self.target.surface
    }
}

pub(crate) struct SharedPreviewTarget {
    pub(crate) size: Extent2d,
    pub(crate) texture: wgpu::Texture,
    surface: Surface,
}

impl SharedPreviewTarget {
    pub(crate) fn allocation_bytes(
        device: &wgpu::Device,
        size: Extent2d,
    ) -> Result<u64, RenderError> {
        if size.width > device.limits().max_texture_dimension_2d
            || size.height > device.limits().max_texture_dimension_2d
        {
            return Err(RenderError::Invalid(
                "shared preview extent exceeds device limits".into(),
            ));
        }
        Surface::allocation_bytes(size.width, size.height).map_err(RenderError::Invalid)
    }

    pub(crate) fn new(device: &wgpu::Device, size: Extent2d) -> Result<Self, RenderError> {
        Self::allocation_bytes(device, size)?;
        let surface = Surface::new(size.width, size.height).map_err(RenderError::Gpu)?;
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Metal>() }
            .ok_or_else(|| RenderError::Unsupported("IOSurface preview requires Metal".into()))?;
        let raw = surface
            .metal_texture(hal.raw_device())
            .map_err(RenderError::Gpu)?;
        drop(hal);
        let descriptor = wgpu::TextureDescriptor {
            label: Some("IOSurface BGRA preview"),
            size: wgpu::Extent3d {
                width: size.width,
                height: size.height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Bgra8Unorm,
            usage: wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        };
        let texture = unsafe {
            let raw = wgpu::hal::metal::Device::texture_from_raw(
                raw,
                descriptor.format,
                MTLTextureType::Type2D,
                1,
                1,
                wgpu::hal::CopyExtent {
                    width: size.width,
                    height: size.height,
                    depth: 1,
                },
                None,
            );
            device.create_texture_from_hal::<wgpu::hal::api::Metal>(
                raw,
                &descriptor,
                wgpu::TextureUses::UNINITIALIZED,
            )
        };
        Ok(Self {
            size,
            texture,
            surface,
        })
    }
}

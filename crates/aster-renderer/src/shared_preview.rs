use std::{
    os::windows::io::{AsHandle, BorrowedHandle, FromRawHandle, OwnedHandle},
    sync::Arc,
};

use aster_render_ir::Extent2d;
use windows::{
    Win32::{
        Foundation::GENERIC_ALL,
        Graphics::{Direct3D12::*, Dxgi::Common::*},
    },
    core::PCWSTR,
};

use crate::RenderError;

/// A completed BGRA output remains immutable until every consumer releases its lease.
pub struct SharedPreviewFrame {
    pub(crate) target: Arc<SharedPreviewTarget>,
}

impl AsHandle for SharedPreviewFrame {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.target.handle.as_handle()
    }
}

impl SharedPreviewFrame {
    /// The extent belongs to the allocation and cannot be changed independently of its handle.
    pub fn size(&self) -> Extent2d {
        self.target.size
    }
}

pub(crate) struct SharedPreviewTarget {
    pub(crate) size: Extent2d,
    pub(crate) texture: wgpu::Texture,
    handle: OwnedHandle,
}

impl SharedPreviewTarget {
    fn descriptor(size: Extent2d) -> D3D12_RESOURCE_DESC {
        D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            Width: u64::from(size.width),
            Height: size.height,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
            Flags: D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS
                | D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,
            ..Default::default()
        }
    }

    pub(crate) fn allocation_bytes(
        device: &wgpu::Device,
        size: Extent2d,
    ) -> Result<u64, RenderError> {
        if size.width == 0
            || size.height == 0
            || size.width > device.limits().max_texture_dimension_2d
            || size.height > device.limits().max_texture_dimension_2d
        {
            return Err(RenderError::Invalid(
                "shared preview extent exceeds device limits".into(),
            ));
        }
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
            .ok_or_else(|| RenderError::Unsupported("shared preview requires DX12".into()))?;
        let info = unsafe {
            hal.raw_device()
                .GetResourceAllocationInfo(0, &[Self::descriptor(size)])
        };
        if info.SizeInBytes == 0 || info.SizeInBytes == u64::MAX {
            return Err(RenderError::Gpu(
                "shared preview allocation unsupported".into(),
            ));
        }
        Ok(info.SizeInBytes)
    }

    pub(crate) fn new(device: &wgpu::Device, size: Extent2d) -> Result<Self, RenderError> {
        let result = (|| -> Result<Self, Box<dyn std::error::Error>> {
            let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
                .ok_or("shared preview requires DX12")?;
            let mut resource: Option<ID3D12Resource> = None;
            unsafe {
                hal.raw_device().CreateCommittedResource(
                    &D3D12_HEAP_PROPERTIES {
                        Type: D3D12_HEAP_TYPE_DEFAULT,
                        CreationNodeMask: 1,
                        VisibleNodeMask: 1,
                        ..Default::default()
                    },
                    D3D12_HEAP_FLAG_SHARED,
                    &Self::descriptor(size),
                    D3D12_RESOURCE_STATE_COMMON,
                    None,
                    &mut resource,
                )?;
            }
            let resource = resource.ok_or("shared preview resource missing")?;
            let handle = unsafe {
                OwnedHandle::from_raw_handle(
                    hal.raw_device()
                        .CreateSharedHandle(&resource, None, GENERIC_ALL.0, PCWSTR::null())?
                        .0,
                )
            };
            drop(hal);
            let descriptor = wgpu::TextureDescriptor {
                label: Some("Shared BGRA preview"),
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
            // The entire allocation is copied before publication. The owned HAL texture and
            // handle outlive GPU completion and every external consumer of this lease.
            let texture = unsafe {
                let raw = wgpu::hal::dx12::Device::texture_from_raw(
                    resource,
                    descriptor.format,
                    descriptor.dimension,
                    descriptor.size,
                    1,
                    1,
                );
                device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
                    raw,
                    &descriptor,
                    wgpu::TextureUses::UNINITIALIZED,
                )
            };
            Ok(Self {
                size,
                texture,
                handle,
            })
        })();
        result.map_err(|error| RenderError::Gpu(error.to_string()))
    }
}

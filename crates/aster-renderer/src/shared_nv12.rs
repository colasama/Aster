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

/// A lease keeps both texture planes and their shared handle alive until the consumer releases it.
pub struct SharedNv12Frame {
    pub(crate) target: Arc<SharedNv12Target>,
}

impl AsHandle for SharedNv12Frame {
    fn as_handle(&self) -> BorrowedHandle<'_> {
        self.target.handle.as_handle()
    }
}

pub(crate) struct SharedNv12Target {
    pub(crate) size: Extent2d,
    pub(crate) planes: [wgpu::Texture; 2],
    handle: OwnedHandle,
}

impl SharedNv12Target {
    fn descriptor(size: Extent2d) -> D3D12_RESOURCE_DESC {
        D3D12_RESOURCE_DESC {
            Dimension: D3D12_RESOURCE_DIMENSION_TEXTURE2D,
            Width: u64::from(size.width),
            Height: size.height,
            DepthOrArraySize: 1,
            MipLevels: 1,
            Format: DXGI_FORMAT_NV12,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Layout: D3D12_TEXTURE_LAYOUT_UNKNOWN,
            // The render-target flag provides a D3D11-compatible shared descriptor.
            Flags: D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS
                | D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET,
            ..Default::default()
        }
    }

    pub(crate) fn allocation_bytes(
        device: &wgpu::Device,
        size: Extent2d,
    ) -> Result<u64, RenderError> {
        let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
            .ok_or_else(|| RenderError::Invalid("shared NV12 requires DX12".into()))?;
        let info = unsafe {
            hal.raw_device()
                .GetResourceAllocationInfo(0, &[Self::descriptor(size)])
        };
        if info.SizeInBytes == u64::MAX || info.SizeInBytes == 0 {
            return Err(RenderError::Gpu(
                "shared NV12 allocation unsupported".into(),
            ));
        }
        Ok(info.SizeInBytes)
    }

    pub(crate) fn new(device: &wgpu::Device, size: Extent2d) -> Result<Self, RenderError> {
        let result = (|| -> Result<Self, Box<dyn std::error::Error>> {
            let hal = unsafe { device.as_hal::<wgpu::hal::api::Dx12>() }
                .ok_or("shared NV12 requires DX12")?;
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
            let resource = resource.ok_or("shared NV12 resource missing")?;
            let handle = unsafe {
                let handle = hal.raw_device().CreateSharedHandle(
                    &resource,
                    None,
                    GENERIC_ALL.0,
                    PCWSTR::null(),
                )?;
                OwnedHandle::from_raw_handle(handle.0)
            };
            drop(hal);
            let plane = |index: u32, format: wgpu::TextureFormat, width, height| {
                let descriptor = wgpu::TextureDescriptor {
                    label: Some("Shared NV12 plane"),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::COPY_DST,
                    view_formats: &[],
                };
                // Each alias owns a distinct plane, is used only as COPY_DST, and is
                // retained through GPU completion and the consumer's entire lease.
                unsafe {
                    let texture = wgpu::hal::dx12::Device::texture_from_raw(
                        resource.clone(),
                        format,
                        descriptor.dimension,
                        descriptor.size,
                        1,
                        1,
                    )
                    .with_plane_slice(index);
                    device.create_texture_from_hal::<wgpu::hal::api::Dx12>(
                        texture,
                        &descriptor,
                        wgpu::TextureUses::UNINITIALIZED,
                    )
                }
            };
            Ok(Self {
                size,
                planes: [
                    plane(0, wgpu::TextureFormat::R8Unorm, size.width, size.height),
                    plane(
                        1,
                        wgpu::TextureFormat::Rg8Unorm,
                        size.width / 2,
                        size.height / 2,
                    ),
                ],
                handle,
            })
        })();
        result.map_err(|error| RenderError::Gpu(error.to_string()))
    }
}

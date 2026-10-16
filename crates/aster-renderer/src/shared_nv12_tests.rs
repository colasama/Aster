use super::{NativeOptions, NativeRenderer};
use crate::SharedNv12Frame;
use aster_render::NativeBackend;
use aster_render_ir::{AdapterLuid, Extent2d};
use std::{
    os::windows::io::{AsHandle, AsRawHandle},
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{HANDLE, HMODULE},
        Graphics::{Direct3D::*, Direct3D11::*, Dxgi::*},
    },
    core::Interface,
};

struct SharedReader {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}

impl SharedReader {
    fn new(luid: AdapterLuid) -> Result<Self, Box<dyn std::error::Error>> {
        unsafe {
            let factory: IDXGIFactory4 = CreateDXGIFactory1()?;
            let adapter: IDXGIAdapter =
                factory.EnumAdapterByLuid(windows::Win32::Foundation::LUID {
                    LowPart: luid.low,
                    HighPart: luid.high,
                })?;
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            Ok(Self {
                device: device.ok_or("D3D11 device missing")?,
                context: context.ok_or("D3D11 context missing")?,
            })
        }
    }

    fn read(&self, frame: &SharedNv12Frame) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        unsafe {
            let device: ID3D11Device1 = self.device.cast()?;
            let texture: ID3D11Texture2D =
                device.OpenSharedResource1(HANDLE(frame.as_handle().as_raw_handle()))?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.MiscFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            let mut staging = None;
            self.device
                .CreateTexture2D(&desc, None, Some(&mut staging))?;
            let staging = staging.ok_or("D3D11 staging missing")?;
            self.context.CopyResource(&staging, &texture);
            self.context.Flush();
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            let started = Instant::now();
            loop {
                match self.context.Map(
                    &staging,
                    0,
                    D3D11_MAP_READ,
                    D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                    Some(&mut mapped),
                ) {
                    Ok(()) => break,
                    Err(error)
                        if error.code() == DXGI_ERROR_WAS_STILL_DRAWING
                            && started.elapsed() < Duration::from_secs(30) =>
                    {
                        std::thread::sleep(Duration::from_millis(1))
                    }
                    Err(error) => return Err(error.into()),
                }
            }
            let mut bytes = Vec::new();
            let valid = !mapped.pData.is_null() && mapped.RowPitch >= desc.Width;
            if valid {
                let mapped_bytes = std::slice::from_raw_parts(
                    mapped.pData.cast::<u8>(),
                    (mapped.RowPitch * desc.Height * 3 / 2) as usize,
                );
                for row in mapped_bytes.chunks_exact(mapped.RowPitch as usize) {
                    bytes.extend_from_slice(&row[..desc.Width as usize]);
                }
            }
            self.context.Unmap(&staging, 0);
            if !valid {
                return Err("invalid shared NV12 mapping".into());
            }
            Ok(bytes)
        }
    }
}

#[test]
#[ignore = "requires GPU"]
fn shared_nv12_planes_are_exact_and_leases_bound_reuse() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let size = Extent2d {
        width: 66,
        height: 34,
    };
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: NativeBackend::Dx12,
        adapter_name: None,
        dxcompiler: Some(root.join("node_modules/electron/dist/dxcompiler.dll")),
        gpu_budget_bytes: 64 * 1024 * 1024,
        layer_cache_bytes: 0,
        effect_pipeline_entries: 16,
        gpu_timestamps: true,
        effect_regions: true,
        timeout: Duration::from_secs(30),
    })?;
    renderer.prepare_shared_nv12(size, 1)?;
    let reader = SharedReader::new(renderer.adapter_luid().ok_or("LUID missing")?)?;
    let texture = renderer.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Shared NV12 diagnostic"),
        size: wgpu::Extent3d {
            width: size.width,
            height: size.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for frame in 0..12 {
        let bgra = (0..size.width * size.height)
            .flat_map(|pixel| {
                [
                    ((pixel + frame * 31) % 256) as u8,
                    ((pixel / size.width * 7 + frame) % 256) as u8,
                    ((pixel * 3 + frame * 11) % 256) as u8,
                    255,
                ]
            })
            .collect::<Vec<_>>();
        renderer.queue.write_texture(
            texture.as_image_copy(),
            &bgra,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size.width * 4),
                rows_per_image: None,
            },
            texture.size(),
        );
        let expected = renderer
            .nv12
            .as_ref()
            .ok_or("NV12 converter missing")?
            .read(
                &renderer.device,
                &renderer.queue,
                &texture,
                Duration::from_secs(30),
                None,
            )?;
        let shared = renderer.share_nv12_texture(&texture)?;
        let timing = renderer
            .gpu_timings()
            .ok_or("GPU conversion timings missing")?;
        assert!(timing.nv12_conversion_ms > 0.0);
        assert!(timing.nv12_copy_ms >= 0.0);
        assert!(
            renderer.share_nv12_texture(&texture).is_err(),
            "a leased slot must never be overwritten"
        );
        assert_eq!(
            reader.read(&shared)?,
            expected,
            "shared planes differ on frame {frame}"
        );
        if frame == 11 {
            drop(renderer);
            assert_eq!(
                reader.read(&shared)?,
                expected,
                "lease must survive renderer shutdown"
            );
            return Ok(());
        }
    }
    Err("shared NV12 lifetime loop did not complete".into())
}

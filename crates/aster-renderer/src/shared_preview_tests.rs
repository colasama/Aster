use super::{NativeOptions, NativeRenderer};
use crate::SharedPreviewFrame;
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

struct SharedPreviewReader {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
}
impl SharedPreviewReader {
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
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
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
    fn read(&self, frame: &SharedPreviewFrame) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        unsafe {
            let device: ID3D11Device1 = self.device.cast()?;
            let texture: ID3D11Texture2D =
                device.OpenSharedResource1(HANDLE(frame.as_handle().as_raw_handle()))?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            assert_eq!(desc.Format, Common::DXGI_FORMAT_B8G8R8A8_UNORM);
            assert_eq!(
                (desc.Width, desc.Height),
                (frame.size().width, frame.size().height)
            );
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.MiscFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            let mut staging = None;
            self.device
                .CreateTexture2D(&desc, None, Some(&mut staging))?;
            let staging = staging.ok_or("preview staging missing")?;
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
            let valid = !mapped.pData.is_null() && mapped.RowPitch >= desc.Width * 4;
            let mut pixels = Vec::new();
            if valid {
                let bytes = std::slice::from_raw_parts(
                    mapped.pData.cast::<u8>(),
                    mapped.RowPitch as usize * desc.Height as usize,
                );
                for row in bytes.chunks_exact(mapped.RowPitch as usize) {
                    pixels.extend_from_slice(&row[..desc.Width as usize * 4]);
                }
            }
            self.context.Unmap(&staging, 0);
            if !valid {
                return Err("invalid preview row mapping".into());
            }
            Ok(pixels)
        }
    }
}

#[test]
#[ignore = "requires GPU"]
fn shared_preview_bgra_preserves_alpha_and_owns_reuse() -> Result<(), Box<dyn std::error::Error>> {
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let size = Extent2d {
        width: 67,
        height: 35,
    };
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: NativeBackend::Dx12,
        adapter_name: None,
        dxcompiler: Some(root.join("node_modules/electron/dist/dxcompiler.dll")),
        gpu_budget_bytes: 64 * 1024 * 1024,
        layer_cache_bytes: 0,
        effect_regions: true,
        effect_pipeline_entries: 16,
        gpu_timestamps: false,
        timeout: Duration::from_secs(30),
    })?;
    assert!(renderer.prepare_shared_preview(size, 0).is_err());
    assert!(renderer.prepare_shared_preview(size, 4).is_err());
    assert!(
        renderer
            .prepare_shared_preview(
                Extent2d {
                    width: 0,
                    height: 1
                },
                1
            )
            .is_err()
    );
    renderer.prepare_shared_preview(size, 1)?;
    renderer.prepare_shared_preview(size, 1)?;
    assert!(
        renderer
            .prepare_shared_preview(
                Extent2d {
                    width: 68,
                    height: 35
                },
                1
            )
            .is_err()
    );
    let reader = SharedPreviewReader::new(renderer.adapter_luid().ok_or("preview LUID absent")?)?;
    let source = renderer.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("Preview transport witness"),
        size: wgpu::Extent3d {
            width: size.width,
            height: size.height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Bgra8Unorm,
        usage: wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for index in 0..12 {
        let pixels = (0..size.width * size.height)
            .flat_map(|pixel| {
                let alpha = ((pixel + index * 23) % 256) as u8;
                [
                    ((pixel * 3 + index) % (u32::from(alpha) + 1)) as u8,
                    ((pixel + index * 7) % (u32::from(alpha) + 1)) as u8,
                    ((pixel * 11 + index) % (u32::from(alpha) + 1)) as u8,
                    alpha,
                ]
            })
            .collect::<Vec<_>>();
        renderer.queue.write_texture(
            source.as_image_copy(),
            &pixels,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size.width * 4),
                rows_per_image: None,
            },
            source.size(),
        );
        let shared = renderer.share_preview_texture(&source)?;
        assert!(renderer.share_preview_texture(&source).is_err());
        assert!(renderer.release_shared_preview().is_err());
        assert_eq!(
            reader.read(&shared)?,
            pixels,
            "BGRA/alpha bytes changed on frame {index}"
        );
        if index == 11 {
            drop(renderer);
            assert_eq!(
                reader.read(&shared)?,
                pixels,
                "shared output must outlive renderer shutdown"
            );
            return Ok(());
        }
        drop(shared);
        renderer.release_shared_preview()?;
        assert_eq!(renderer.options.gpu_budget_bytes, 64 * 1024 * 1024);
        renderer.prepare_shared_preview(size, 1)?;
    }
    Err("preview ownership sequence did not complete".into())
}

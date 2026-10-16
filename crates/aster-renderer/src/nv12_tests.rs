use std::{
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::Duration,
};

use aster_render::NativeBackend;
use aster_render_ir::Extent2d;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{NativeOptions, NativeRenderer};
use crate::nv12::Nv12Converter;

struct Nv12Fixture;

#[derive(Serialize)]
struct Nv12Evidence {
    pattern: u32,
    size: Extent2d,
    peak_error: u8,
    signed_bias: f64,
    source_rgba_sha256: String,
    reference_nv12_sha256: String,
    candidate_nv12_sha256: String,
}

impl Nv12Fixture {
    fn reference(rgba: &[u8], size: Extent2d) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut command = Command::new(root.join("build/ffmpeg/ffmpeg.exe"));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .args([
                "-v",
                "error",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgba",
                "-video_size",
                &format!("{}x{}", size.width, size.height),
                "-i",
                "pipe:0",
                "-frames:v",
                "1",
                "-vf",
                "scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=nv12",
                "-f",
                "rawvideo",
                "pipe:1",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;
        child
            .stdin
            .take()
            .ok_or("FFmpeg stdin missing")?
            .write_all(rgba)?;
        let result = child.wait_with_output()?;
        if !result.status.success() {
            return Err(String::from_utf8_lossy(&result.stderr).into_owned().into());
        }
        Ok(result.stdout)
    }
}

#[test]
fn nv12_budget_counts_both_buffers_and_rejects_odd_dimensions()
-> Result<(), Box<dyn std::error::Error>> {
    assert_eq!(
        Nv12Converter::required_bytes(Extent2d {
            width: 1920,
            height: 1080
        })?,
        6_635_520
    );
    assert_eq!(
        Nv12Converter::required_bytes(Extent2d {
            width: 2,
            height: 2
        })?,
        1536
    );
    assert!(
        Nv12Converter::required_bytes(Extent2d {
            width: 3,
            height: 2
        })
        .is_err()
    );
    assert!(
        Nv12Converter::required_bytes(Extent2d {
            width: 2,
            height: 0
        })
        .is_err()
    );
    Ok(())
}

#[test]
#[ignore = "requires GPU"]
fn gpu_nv12_matches_explicit_bt709_swscale_colors_and_chroma_phase()
-> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let size = Extent2d {
        width: 64,
        height: 32,
    };
    let mut renderer = NativeRenderer::new(NativeOptions {
        backend: NativeBackend::Dx12,
        adapter_name: None,
        dxcompiler: Some(root.join("node_modules/electron/dist/dxcompiler.dll")),
        gpu_budget_bytes: 64 * 1024 * 1024,
        layer_cache_bytes: 0,
        effect_pipeline_entries: 16,
        gpu_timestamps: false,
        effect_regions: true,
        timeout: Duration::from_secs(30),
    })?;
    renderer.prepare_nv12(size)?;
    assert!(
        renderer
            .prepare_nv12(Extent2d {
                width: 32,
                height: 32
            })
            .is_err()
    );
    let texture = renderer.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("NV12 diagnostic input"),
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
    let converter = renderer.nv12.as_ref().ok_or("NV12 converter missing")?;
    for pattern in 0..5 {
        let mut rgba = Vec::new();
        for y in 0..size.height {
            for x in 0..size.width {
                let color = match pattern {
                    0 => match x / 8 {
                        0 => [0, 0, 0],
                        1 => [255, 255, 255],
                        2 => [255, 0, 0],
                        3 => [0, 255, 0],
                        4 => [0, 0, 255],
                        5 => [255, 255, 0],
                        6 => [0, 255, 255],
                        _ => [255, 0, 255],
                    },
                    1 => {
                        if x == 23 {
                            [255, 0, 0]
                        } else {
                            [0, 0, 0]
                        }
                    }
                    2 => {
                        if y == 13 {
                            [255, 0, 0]
                        } else {
                            [0, 0, 0]
                        }
                    }
                    3 => {
                        if y == 0 || y == 31 {
                            [0, 0, 255]
                        } else {
                            [0, 0, 0]
                        }
                    }
                    _ => [(x * 4) as u8, (y * 8) as u8, ((x + y) * 2) as u8],
                };
                rgba.extend([color[0], color[1], color[2], 255]);
            }
        }
        let bgra = rgba
            .chunks_exact(4)
            .flat_map(|p| [p[2], p[1], p[0], p[3]])
            .collect::<Vec<_>>();
        renderer.queue.write_texture(
            texture.as_image_copy(),
            &bgra,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(size.width * 4),
                rows_per_image: Some(size.height),
            },
            texture.size(),
        );
        let pixels = converter.read(
            &renderer.device,
            &renderer.queue,
            &texture,
            Duration::from_secs(30),
            None,
        )?;
        let reference = Nv12Fixture::reference(&rgba, size)?;
        assert_eq!(pixels.len(), reference.len());
        let peak = pixels
            .iter()
            .zip(&reference)
            .map(|(a, b)| a.abs_diff(*b))
            .max()
            .ok_or("no pixels")?;
        let bias = pixels
            .iter()
            .zip(&reference)
            .map(|(a, b)| f64::from(*a) - f64::from(*b))
            .sum::<f64>()
            / pixels.len() as f64;
        if let Some(directory) = std::env::var_os("ASTER_NV12_EVIDENCE_DIR") {
            let directory = PathBuf::from(directory);
            std::fs::create_dir_all(&directory)?;
            let evidence = Nv12Evidence {
                pattern,
                size,
                peak_error: peak,
                signed_bias: bias,
                source_rgba_sha256: format!("{:x}", Sha256::digest(&rgba)),
                reference_nv12_sha256: format!("{:x}", Sha256::digest(&reference)),
                candidate_nv12_sha256: format!("{:x}", Sha256::digest(&pixels)),
            };
            for (name, bytes) in [
                ("source.rgba", rgba),
                ("reference.nv12", reference),
                ("candidate.nv12", pixels),
                ("evidence.json", serde_json::to_vec_pretty(&evidence)?),
            ] {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(directory.join(format!("{pattern}-{name}")))?
                    .write_all(&bytes)?;
            }
        }
        assert!(
            peak <= 1 && bias.abs() <= 0.5,
            "pattern={pattern} peak={peak} bias={bias}"
        );
    }
    Ok(())
}

use aster_encode::{EncoderOptions, HardwareEncoder};
use aster_render_ir::{ExportVideoConfig, Extent2d, RationalFrameRate};
use aster_renderer::{NativeOptions, NativeRenderer};
use clap::Parser;
use std::{path::PathBuf, time::Duration};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    encoder: EncoderOptions,
}

#[test]
#[ignore = "requires Windows hardware encoder and GPU"]
fn repeated_encoder_qualification_and_fallback() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let renderer = if std::env::var_os("ASTER_TEST_ADAPTER_LUID").is_none() {
        Some(NativeRenderer::new(NativeOptions {
            backend: aster_render::NativeBackend::Dx12,
            adapter_name: None,
            dxcompiler: Some(root.join("node_modules/electron/dist/dxcompiler.dll")),
            gpu_budget_bytes: 536870912,
            layer_cache_bytes: 0,
            effect_regions: true,
            effect_pipeline_entries: 0,
            gpu_timestamps: false,
            timeout: Duration::from_secs(30),
        })?)
    } else {
        None
    };
    let luid = if let Some(renderer) = &renderer {
        renderer
            .adapter_luid()
            .ok_or("DX12 adapter identity absent")?
    } else {
        serde_json::from_str(&std::env::var("ASTER_TEST_ADAPTER_LUID")?)?
    };
    eprintln!("adapter identity {}", serde_json::to_string(&luid)?);
    let options = Options::try_parse_from(["encoder-qualification"])?;
    for iteration in 0..32 {
        eprintln!("qualification iteration {iteration}");
        let video = ExportVideoConfig {
            size: Extent2d {
                width: 320,
                height: 180,
            },
            frame_rate: RationalFrameRate {
                numerator: if iteration % 2 == 0 { 30 } else { 30000 },
                denominator: if iteration % 2 == 0 { 1 } else { 1001 },
            },
            bitrate_bps: 6_000_000,
        };
        let mut encoder =
            match HardwareEncoder::new_shared(luid, video.clone(), 12, options.encoder.clone()) {
                Ok(encoder) => encoder,
                Err(aster_encode::EncodeError::Unsupported(reason)) => {
                    eprintln!("readback fallback: {reason}");
                    HardwareEncoder::new(luid, video, 12, options.encoder.clone())?
                }
                Err(error) => return Err(error.into()),
            };
        encoder.cancel();
        assert!(encoder.statistics().cancelled);
    }
    Ok(())
}

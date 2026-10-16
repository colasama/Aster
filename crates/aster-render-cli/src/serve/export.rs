use std::{sync::atomic::AtomicBool, time::Instant};

use aster_encode::{EncodedPacket, HardwareEncoder};
use aster_render_ir::{ExportVideoConfig, FplnCodec};
use aster_renderer::SuppliedFrame;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::{
    Worker,
    inputs::FrameInputs,
    response::{FrameProof, ReplyBody},
};

pub(super) struct ExportSession {
    pub(super) encoder: HardwareEncoder,
    video: ExportVideoConfig,
    shared: bool,
    warmup_frames: u64,
    timings: ExportTimings,
}

/// CPU wall intervals; output completion also includes waiting for prior GPU render submissions.
#[derive(Clone, Default, Serialize)]
pub(super) struct ExportTimings {
    frames: u64,
    plan_decode_ms: f64,
    input_prepare_ms: f64,
    frame_validation_ms: f64,
    render_submit_ms: f64,
    output_completion_ms: f64,
    nv12_completion_ms: f64,
    encoder_submit_ms: f64,
    drain_ms: f64,
    media_cache: aster_media_native::MediaCacheStatistics,
    video_sources: aster_media_native::VideoSourceCacheStatistics,
    video_window: aster_media_native::VideoWindowStatistics,
    texture_cache: aster_media_native::MediaCacheStatistics,
    gpu_images: aster_renderer::ImageCacheStatistics,
    gpu_layers: aster_renderer::LayerCacheStatistics,
    effect_regions: aster_renderer::EffectRegionStatistics,
    #[serde(skip_serializing_if = "Option::is_none")]
    gpu_timings: Option<aster_renderer::GpuTimings>,
}

impl ExportSession {
    fn reply(
        &self,
        frame: Option<u64>,
        proof: Option<FrameProof>,
        packets: Vec<EncodedPacket>,
        complete: bool,
    ) -> (ReplyBody, Vec<u8>) {
        let length = packets.iter().map(|packet| packet.bytes.len()).sum();
        let mut payload = Vec::with_capacity(length);
        let mut metadata = Vec::with_capacity(packets.len());
        for packet in packets {
            metadata.push(packet.metadata);
            payload.extend(packet.bytes);
        }
        (
            ReplyBody::Encoded {
                submitted_frame: frame,
                frame: proof,
                packets: metadata,
                encoder: self.encoder.statistics(),
                timings: Box::new(self.timings.clone()),
                complete,
            },
            payload,
        )
    }
}

impl Worker {
    pub(super) fn begin_export(
        &mut self,
        video: ExportVideoConfig,
        frame_count: u64,
    ) -> Result<ReplyBody, Box<dyn std::error::Error>> {
        if !self.native_readback_export && !self.native_shared_export && !self.native_export {
            return Err("native export is not enabled".into());
        }
        if self.export.is_some() {
            return Err("an export is already active".into());
        }
        video.validate(&self.limits)?;
        let renderer = self
            .renderer
            .as_mut()
            .ok_or("probe the rendering adapter before export")?;
        let luid = renderer
            .adapter_luid()
            .ok_or("native encoder requires a DX12 device identity")?;
        renderer.prepare_nv12(video.size)?;
        let mut shared = self.native_shared_export || self.native_export;
        let mut transport_reason = None;
        let shared_encoder = if shared {
            #[cfg(windows)]
            {
                Some((|| -> Result<_, Box<dyn std::error::Error>> {
                    renderer.prepare_shared_nv12(
                        video.size,
                        self.encoder.max_encoder_inflight_frames.saturating_add(1),
                    )?;
                    Ok(HardwareEncoder::new_shared(
                        luid,
                        video.clone(),
                        frame_count,
                        self.encoder.clone(),
                    )?)
                })())
            }
            #[cfg(not(windows))]
            {
                return Err("shared native export requires Windows".into());
            }
        } else {
            None
        };
        let encoder = match shared_encoder {
            Some(Ok(encoder)) => encoder,
            Some(Err(error)) if !self.native_export => return Err(error),
            fallback => {
                if let Some(Err(error)) = fallback {
                    transport_reason = Some(error.to_string());
                    #[cfg(windows)]
                    renderer.release_shared_nv12()?;
                }
                shared = false;
                HardwareEncoder::new(luid, video.clone(), frame_count, self.encoder.clone())?
            }
        };
        let reply = ReplyBody::ExportStarted {
            video: video.clone(),
            frame_count,
            adapter_luid: luid,
            transport: if shared {
                "nv12-shared"
            } else {
                "nv12-readback"
            },
            transport_reason,
            encoder: encoder.statistics(),
        };
        self.export = Some(ExportSession {
            encoder,
            video,
            shared,
            warmup_frames: 0,
            timings: ExportTimings::default(),
        });
        Ok(reply)
    }

    pub(super) fn render_export(
        &mut self,
        frame_index: Option<u64>,
        payload: Vec<u8>,
    ) -> Result<(ReplyBody, Vec<u8>), Box<dyn std::error::Error>> {
        let export = self.export.as_mut().ok_or("no active export")?;
        let accepted = export.encoder.statistics().accepted_frames;
        match frame_index {
            Some(index) if index != accepted => {
                return Err("export frame indices must increase without gaps".into());
            }
            None if accepted != 0 || export.warmup_frames >= self.encoder.max_encoder_frames => {
                return Err("warm-up requires an unstarted export within its frame budget".into());
            }
            _ => {}
        }
        let started = Instant::now();
        let digest = format!("{:x}", Sha256::digest(&payload));
        let plan = FplnCodec::decode(payload, &self.limits)?;
        let proof = FrameProof {
            plan_sha256: digest,
            header: plan.metadata.header.clone(),
        };
        if plan.metadata.header.target != export.video.size {
            return Err("export plan size changed".into());
        }
        let plan_decode_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let mut inputs = FrameInputs::install(self, &plan)?;
        let input_prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        let export = self.export.as_mut().ok_or("no active export")?;
        let result = (|| -> Result<_, Box<dyn std::error::Error>> {
            let started = Instant::now();
            let frame = SuppliedFrame::with_textures(
                plan,
                &self.registry,
                &self.limits,
                &inputs.media.pixels,
                &inputs.textures.pixels,
            )?;
            let frame_validation_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            let renderer = self.renderer.as_mut().ok_or("native renderer missing")?;
            let rendered = renderer.render(&frame, &self.registry)?;
            let render_submit_ms = started.elapsed().as_secs_f64() * 1000.0;
            let started = Instant::now();
            // Complete the selected transport on this same device, but never submit a warm-up
            // to the encoder: dropping encoded packets would corrupt its inter-frame references.
            let Some(frame_index) = frame_index else {
                if export.shared {
                    #[cfg(windows)]
                    drop(renderer.share_nv12(&rendered)?);
                    #[cfg(not(windows))]
                    return Err("shared native export requires Windows".into());
                } else {
                    drop(renderer.read_nv12(&rendered)?);
                }
                export.warmup_frames += 1;
                return Ok((
                    ReplyBody::FrameWarmed {
                        frame: proof,
                        warmup_frames: export.warmup_frames,
                        encoder: export.encoder.statistics(),
                    },
                    Vec::new(),
                ));
            };
            let nv12_completion_ms;
            let packets = if export.shared {
                #[cfg(windows)]
                {
                    let shared = renderer.share_nv12(&rendered)?;
                    nv12_completion_ms = started.elapsed().as_secs_f64() * 1000.0;
                    export
                        .encoder
                        .push_shared(frame_index, shared, &AtomicBool::new(false))?
                }
                #[cfg(not(windows))]
                {
                    return Err("shared native export requires Windows".into());
                }
            } else {
                let nv12 = renderer.read_nv12(&rendered)?;
                nv12_completion_ms = started.elapsed().as_secs_f64() * 1000.0;
                export
                    .encoder
                    .push(frame_index, &nv12, &AtomicBool::new(false))?
            };
            let output_completion_ms = started.elapsed().as_secs_f64() * 1000.0;
            export.timings.frames += 1;
            if let Some(timing) = renderer.gpu_timings() {
                export
                    .timings
                    .gpu_timings
                    .get_or_insert_with(Default::default)
                    .accumulate(timing);
            }
            export.timings.plan_decode_ms += plan_decode_ms;
            export.timings.input_prepare_ms += input_prepare_ms;
            // Session totals include warm-up; copy the latest counters rather than summing them.
            export.timings.media_cache = inputs.media.decode_cache;
            export.timings.video_sources = inputs.media.video_source_cache;
            export.timings.video_window = inputs.media.video_decode_window;
            export.timings.texture_cache = inputs.textures.cache;
            export.timings.gpu_images = rendered.image_cache;
            export.timings.gpu_layers = rendered.layer_cache;
            export.timings.effect_regions.isolated_passes +=
                rendered.effect_regions.isolated_passes;
            export.timings.effect_regions.bounded_passes += rendered.effect_regions.bounded_passes;
            export.timings.effect_regions.full_pixels += rendered.effect_regions.full_pixels;
            export.timings.effect_regions.drawn_pixels += rendered.effect_regions.drawn_pixels;
            export.timings.frame_validation_ms += frame_validation_ms;
            export.timings.render_submit_ms += render_submit_ms;
            export.timings.output_completion_ms += output_completion_ms;
            export.timings.nv12_completion_ms += nv12_completion_ms;
            export.timings.encoder_submit_ms += output_completion_ms - nv12_completion_ms;
            Ok(export.reply(Some(frame_index), Some(proof), packets, false))
        })();
        inputs.release(&mut self.registry)?;
        result
    }

    pub(super) fn finish_export(
        &mut self,
    ) -> Result<(ReplyBody, Vec<u8>), Box<dyn std::error::Error>> {
        let mut export = self.export.take().ok_or("no active export")?;
        let started = Instant::now();
        let packets = export.encoder.finish(&AtomicBool::new(false))?;
        export.timings.drain_ms += started.elapsed().as_secs_f64() * 1000.0;
        Ok(export.reply(None, None, packets, true))
    }
}

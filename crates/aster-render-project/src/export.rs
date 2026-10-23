use crate::{
    NativeProjectSession, NativeRasterProvider, ProjectExportControl, ProjectExportSchedule,
    ProjectFrameSettings, ProjectRasterFrame, ProjectRenderError, export_audio::ExportAudio,
};
use aster_encode::{EncodedPacket, EncoderOptions, EncoderStatistics, HardwareEncoder};
use aster_render_ir::RationalFrameRate;
use aster_video::{
    EncodedVideoExportRequest, ExportFrameSender, ExportLimits, FfmpegExportBackend,
};
use serde::Serialize;
use std::{path::PathBuf, time::Instant};

/// Optional diagnostic observer; normal exports perform no additional pixel readback.
pub trait ProjectExportObserver {
    fn observe(
        &mut self,
        index: u64,
        request: &aster_eval::FramePlanRequest,
        prepared: &crate::PreparedProjectFrame,
        rendered: &aster_renderer::RenderedFrame,
        renderer: &mut aster_renderer::NativeRenderer,
        encoder_input: Option<&[u8]>,
    ) -> Result<(), ProjectRenderError>;
}

pub struct NativeProjectExport {
    pub session: NativeProjectSession,
    pub schedule: ProjectExportSchedule,
    pub settings: ProjectFrameSettings,
    pub raster_provider: Option<NativeRasterProvider>,
    pub include_audio: bool,
    pub encoder_options: EncoderOptions,
    pub mux_limits: ExportLimits,
    pub ffmpeg: PathBuf,
    pub output: PathBuf,
    pub control: ProjectExportControl,
}

#[derive(Serialize)]
pub struct ProjectExportProgress {
    pub stage: &'static str,
    pub rendered_frames: u64,
    pub total_frames: u64,
    pub elapsed_ms: u128,
}

#[derive(Serialize)]
pub struct ProjectExportReport {
    pub output: PathBuf,
    pub frames: u64,
    pub audio_frames: u64,
    pub output_bytes: u64,
    pub elapsed_ms: u128,
    pub transport: &'static str,
    pub transport_reason: Option<String>,
    pub encoder: EncoderStatistics,
}

struct PacketSink {
    sender: ExportFrameSender,
    rate: RationalFrameRate,
    accepted: u64,
    count: u64,
    maximum_bytes: usize,
}

impl PacketSink {
    fn push(&mut self, packets: Vec<EncodedPacket>) -> Result<(), ProjectRenderError> {
        for packet in packets {
            let timestamp =
                u128::from(self.accepted) * 10_000_000 * u128::from(self.rate.denominator)
                    / u128::from(self.rate.numerator);
            let next =
                (u128::from(self.accepted) + 1) * 10_000_000 * u128::from(self.rate.denominator)
                    / u128::from(self.rate.numerator);
            if self.accepted >= self.count
                || packet.metadata.frame_index != self.accepted
                || i128::from(packet.metadata.timestamp_100ns) != timestamp as i128
                || i128::from(packet.metadata.duration_100ns) != (next - timestamp) as i128
                || packet.metadata.payload_bytes as usize != packet.bytes.len()
                || packet.bytes.len() > self.maximum_bytes
            {
                return Err(ProjectRenderError::Invalid(
                    "encoder packet identity, clock or byte budget differs".into(),
                ));
            }
            self.sender
                .send_frame(Ok(packet.bytes))
                .map_err(|error| ProjectRenderError::Invalid(error.to_string()))?;
            self.accepted += 1;
        }
        Ok(())
    }

    fn finish(self) -> Result<(), ProjectRenderError> {
        if self.accepted != self.count {
            return Err(ProjectRenderError::Invalid(
                "encoder did not produce every frame".into(),
            ));
        }
        self.sender
            .finish()
            .map_err(|error| ProjectRenderError::Invalid(error.to_string()))
    }
}

impl NativeProjectExport {
    pub fn run(
        mut self,
        mut progress: impl FnMut(ProjectExportProgress),
        mut observer: Option<&mut dyn ProjectExportObserver>,
    ) -> Result<ProjectExportReport, ProjectRenderError> {
        if self.schedule.format != crate::ProjectExportFormat::Mp4 {
            return Err(ProjectRenderError::Invalid(
                "video export requires an MP4 schedule".into(),
            ));
        }
        self.control.wait()?;
        if self.output.try_exists()? {
            return Err(ProjectRenderError::Invalid(
                "export destination already exists".into(),
            ));
        }
        let started = Instant::now();
        let count = self.schedule.frames.len() as u64;
        let video = self.schedule.video.clone();
        if count == 0
            || count > self.mux_limits.max_frame_count
            || video.size.width > self.mux_limits.max_width
            || video.size.height > self.mux_limits.max_height
            || u64::from(video.bitrate_bps) > self.mux_limits.max_video_bitrate_bps
        {
            return Err(ProjectRenderError::Invalid(
                "export exceeds configured mux limits".into(),
            ));
        }
        progress(ProjectExportProgress {
            stage: "audio",
            rendered_frames: 0,
            total_frames: count,
            elapsed_ms: started.elapsed().as_millis(),
        });
        let audio = ExportAudio::prepare(
            &self.session.audio,
            &self.schedule,
            &self.control,
            self.mux_limits.max_audio_source_bytes,
            self.include_audio,
        )?;
        progress(ProjectExportProgress {
            stage: "encoder",
            rendered_frames: 0,
            total_frames: count,
            elapsed_ms: started.elapsed().as_millis(),
        });
        let renderer = &mut self.session.gpu.renderer;
        let luid = renderer.adapter_luid().ok_or_else(|| {
            ProjectRenderError::Invalid(
                "hardware export requires a supported adapter identity".into(),
            )
        })?;
        renderer.prepare_nv12(video.size)?;
        let mut shared = false;
        let mut transport_reason = None;
        #[cfg(windows)]
        let shared_encoder = (|| -> Result<HardwareEncoder, ProjectRenderError> {
            renderer.prepare_shared_nv12(
                video.size,
                self.encoder_options
                    .max_encoder_inflight_frames
                    .saturating_add(1),
            )?;
            Ok(HardwareEncoder::new_shared(
                luid,
                video.clone(),
                count,
                self.encoder_options.clone(),
            )?)
        })();
        #[cfg(not(windows))]
        let shared_encoder: Result<HardwareEncoder, ProjectRenderError> = Err(
            ProjectRenderError::Invalid("shared encoder unavailable on this platform".into()),
        );
        let mut encoder = match shared_encoder {
            Ok(encoder) => {
                shared = true;
                encoder
            }
            Err(error) => {
                transport_reason = Some(error.to_string());
                #[cfg(windows)]
                renderer.release_shared_nv12()?;
                HardwareEncoder::new(luid, video.clone(), count, self.encoder_options.clone())?
            }
        };
        let (sender, receiver) = self.mux_limits.frame_channel(2)?;
        let maximum_bytes = self.encoder_options.max_encoder_packet_bytes as usize;
        let request = EncodedVideoExportRequest {
            output_path: self.output.clone(),
            frame_rate_numerator: video.frame_rate.numerator,
            frame_rate_denominator: video.frame_rate.denominator,
            frame_count: count,
            maximum_packet_bytes: maximum_bytes,
            audio: audio.spec.clone(),
        };
        request.validate(&self.mux_limits)?;
        let backend = FfmpegExportBackend::with_limits(self.ffmpeg, self.mux_limits);
        let cancel = self.control.cancellation.clone();
        let mux = std::thread::spawn(move || {
            let result = backend.mux_h264(&request, receiver, &cancel);
            // Release a producer paused at a safe boundary when the consumer has already failed.
            if result.is_err() {
                cancel.cancel();
            }
            result
        });
        let mut sink = PacketSink {
            sender,
            rate: video.frame_rate,
            accepted: 0,
            count,
            maximum_bytes,
        };
        progress(ProjectExportProgress {
            stage: "render",
            rendered_frames: 0,
            total_frames: count,
            elapsed_ms: started.elapsed().as_millis(),
        });
        let produce = (|| -> Result<(), ProjectRenderError> {
            for (index, frame) in self.schedule.frames.iter().enumerate() {
                self.control.wait()?;
                let prepared = self.session.prepare(
                    &frame,
                    &self.settings,
                    &self.control.cancellation,
                    |requests| match &mut self.raster_provider {
                        Some(provider) => provider.acquire(requests, &self.control.cancellation),
                        None => Ok(ProjectRasterFrame::default()),
                    },
                )?;
                let rendered = self.session.render(&prepared, &self.control.cancellation)?;
                let packets = if shared {
                    #[cfg(windows)]
                    {
                        let surface = self.session.gpu.renderer.share_nv12(&rendered)?;
                        if let Some(observer) = observer.as_deref_mut() {
                            observer.observe(
                                index as u64,
                                &frame,
                                &prepared,
                                &rendered,
                                &mut self.session.gpu.renderer,
                                None,
                            )?;
                        }
                        encoder.push_shared(
                            index as u64,
                            surface,
                            self.control.cancellation.as_ref(),
                        )?
                    }
                    #[cfg(not(windows))]
                    {
                        return Err(ProjectRenderError::Invalid(
                            "shared encoder unavailable".into(),
                        ));
                    }
                } else {
                    let pixels = self.session.gpu.renderer.read_nv12(&rendered)?;
                    if let Some(observer) = observer.as_deref_mut() {
                        observer.observe(
                            index as u64,
                            &frame,
                            &prepared,
                            &rendered,
                            &mut self.session.gpu.renderer,
                            Some(&pixels),
                        )?;
                    }
                    encoder.push(index as u64, &pixels, self.control.cancellation.as_ref())?
                };
                sink.push(packets)?;
                progress(ProjectExportProgress {
                    stage: "render",
                    rendered_frames: index as u64 + 1,
                    total_frames: count,
                    elapsed_ms: started.elapsed().as_millis(),
                });
            }
            self.control.wait()?;
            sink.push(encoder.finish(self.control.cancellation.as_ref())?)?;
            let statistics = encoder.statistics();
            if !statistics.drain_completed
                || statistics.accepted_frames != count
                || statistics.encoded_frames != count
            {
                return Err(ProjectRenderError::Invalid(
                    "encoder drain receipt incomplete".into(),
                ));
            }
            Ok(())
        })();
        let produce = produce.and_then(|()| sink.finish());
        if produce.is_err() {
            self.control.cancellation.cancel();
            encoder.cancel();
        }
        let mux = mux
            .join()
            .map_err(|_| ProjectRenderError::Invalid("mux worker panicked".into()))?;
        let mux = match (produce, mux) {
            // Preserve the consumer's cause instead of reporting its cooperative shutdown as
            // a user cancellation. Independent producer errors retain their original cause.
            (_, Err(error @ aster_video::ExportError::TimedOut { .. }))
            | (
                Err(
                    ProjectRenderError::Audio(aster_video::FfmpegError::Cancelled)
                    | ProjectRenderError::Encode(aster_encode::EncodeError::Cancelled),
                ),
                Err(error),
            ) => return Err(error.into()),
            (Err(error), _) => return Err(error),
            (Ok(()), result) => result?,
        };
        Ok(ProjectExportReport {
            output: mux.output_path,
            frames: count,
            audio_frames: audio.frames,
            output_bytes: mux.bytes_written,
            elapsed_ms: started.elapsed().as_millis(),
            transport: if shared {
                "nv12-shared"
            } else {
                "nv12-readback"
            },
            transport_reason,
            encoder: encoder.statistics(),
        })
    }
}

#[cfg(test)]
mod tests;

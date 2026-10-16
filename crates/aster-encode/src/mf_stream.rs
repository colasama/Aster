use std::{
    collections::BTreeMap,
    os::windows::io::AsHandle,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

use aster_render_ir::{AdapterLuid, ExportVideoConfig};
use windows::{Win32::Media::MediaFoundation::*, core::Interface};

use crate::{
    EncodeError, EncodedPacket, EncoderOptions, EncoderStatistics,
    media_foundation::{ActiveTransform, MfRuntime},
    mf_gpu::{GpuInputDevice, GpuInputLease},
    mf_packet::MfPacket,
    probe_stream::ProbeStream,
};

pub(crate) struct MfEncoder {
    active: Option<ActiveTransform>,
    events: IMFMediaEventGenerator,
    gpu: Option<GpuInputDevice>,
    gpu_leases: BTreeMap<u64, GpuInputLease>,
    // Drop the transform and event interface before releasing the COM/MF thread scope.
    _runtime: MfRuntime,
    video: ExportVideoConfig,
    frames: u64,
    options: EncoderOptions,
    credits: u32,
    draining: bool,
    pub(crate) statistics: EncoderStatistics,
}

impl MfEncoder {
    pub(crate) fn new(
        luid: AdapterLuid,
        video: ExportVideoConfig,
        frames: u64,
        options: EncoderOptions,
        shared: bool,
    ) -> Result<Self, EncodeError> {
        let runtime = MfRuntime::start()?;
        let gpu = if shared {
            Some(GpuInputDevice::new(luid)?)
        } else {
            None
        };
        let encoders = runtime
            .encoders(luid, &options.probe)
            .map_err(|error| EncodeError::Platform(error.to_string()))?;
        let mut failures = Vec::new();
        for activation in encoders {
            let name = MfRuntime::name(&activation)
                .map_err(|error| EncodeError::Platform(error.to_string()))?;
            let tested = ActiveTransform::configure(
                &activation,
                &video,
                gpu.as_ref().map(|gpu| &gpu.manager),
                &options.probe,
            )
            .map_err(EncodeError::from)
            .and_then(|mut active| {
                ProbeStream::verify(&mut active, &video, &options.probe, gpu.as_ref())
                    .map_err(|error| EncodeError::Platform(error.to_string()))?;
                Ok(active)
            });
            let active = match tested {
                Ok(active) => active,
                Err(error) => {
                    failures.push(format!("{name}: {error}"));
                    continue;
                }
            };
            unsafe {
                // Retain the qualified device/transform pair across the stream boundary.
                // Flush removes probe packets before a new job requests input credits.
                active
                    .transform
                    .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0)?;
                let events: IMFMediaEventGenerator = active.transform.cast()?;
                let reset_started = Instant::now();
                loop {
                    if reset_started.elapsed() >= Duration::from_millis(options.encoder_timeout_ms)
                    {
                        return Err(EncodeError::TimedOut);
                    }
                    match events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                        Ok(event) => {
                            event.GetStatus()?.ok()?;
                        }
                        Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => break,
                        Err(error) => return Err(error.into()),
                    }
                }
                active
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                active
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                return Ok(Self {
                    active: Some(active),
                    events,
                    gpu,
                    gpu_leases: BTreeMap::new(),
                    _runtime: runtime,
                    video,
                    frames,
                    options,
                    credits: 0,
                    draining: false,
                    statistics: EncoderStatistics {
                        encoder_name: name,
                        ..Default::default()
                    },
                });
            }
        }
        Err(EncodeError::Unsupported(format!(
            "No verified adapter-matched hardware encoder: {}",
            failures.join("; ")
        )))
    }

    pub(crate) fn push(
        &mut self,
        frame: u64,
        nv12: &[u8],
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        let result = (|| {
            let expected =
                u64::from(self.video.size.width) * u64::from(self.video.size.height) * 3 / 2;
            if self.gpu.is_some() || nv12.len() as u64 != expected {
                return Err(EncodeError::Invalid("NV12 input size or transport".into()));
            }
            let sample = MfPacket::input(&self.video, frame, nv12)?;
            self.push_frame(frame, sample, None, cancel)
        })();
        if let Err(error) = &result {
            self.terminate(matches!(error, EncodeError::Cancelled));
        }
        result
    }

    pub(crate) fn push_shared<F: AsHandle + Send + Sync + 'static>(
        &mut self,
        frame: u64,
        surface: F,
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        let result = (|| {
            if frame != self.statistics.accepted_frames || frame >= self.frames || self.draining {
                return Err(EncodeError::Invalid("shared frame index or state".into()));
            }
            // Keep the new lease local while waiting for capacity: the renderer pool
            // reserves one preparation slot in addition to the encoder's in-flight bound.
            let gpu = self.gpu.as_ref().ok_or_else(|| {
                EncodeError::Invalid("shared input requires a GPU encoder".into())
            })?;
            let (sample, lease) = gpu.shared_sample(&self.video, frame, surface)?;
            self.push_frame(frame, sample, Some(lease), cancel)
        })();
        if let Err(error) = &result {
            self.terminate(matches!(error, EncodeError::Cancelled));
        }
        result
    }

    fn push_frame(
        &mut self,
        frame: u64,
        sample: IMFSample,
        lease: Option<GpuInputLease>,
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        let started = Instant::now();
        self.check_wait(cancel, started)?;
        if self.draining || frame != self.statistics.accepted_frames || frame >= self.frames {
            return Err(EncodeError::Invalid(
                "NV12 frame index, size or stream state".into(),
            ));
        }
        let mut packets = Vec::new();
        let mut bytes = 0;
        while self.credits == 0
            || self.statistics.accepted_frames - self.statistics.encoded_frames
                >= u64::from(self.options.max_encoder_inflight_frames)
            || self.gpu_leases.len() >= self.options.max_encoder_inflight_frames as usize
        {
            self.check_wait(cancel, started)?;
            if !self.poll(&mut packets, &mut bytes)? {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        self.check_wait(cancel, started)?;
        if let Some(lease) = lease {
            self.gpu_leases.insert(frame, lease);
            self.statistics.peak_gpu_leases = self
                .statistics
                .peak_gpu_leases
                .max(self.gpu_leases.len() as u32);
        }
        unsafe {
            self.active
                .as_ref()
                .ok_or_else(|| EncodeError::Invalid("encoder closed".into()))?
                .transform
                .ProcessInput(0, &sample, 0)?;
        }
        drop(sample);
        if self.gpu.is_some() {
            self.statistics.gpu_input_frames += 1;
        }
        self.credits -= 1;
        self.statistics.accepted_frames += 1;
        let inflight = self.statistics.accepted_frames - self.statistics.encoded_frames;
        self.statistics.peak_inflight_frames =
            self.statistics.peak_inflight_frames.max(inflight as u32);
        while self.poll(&mut packets, &mut bytes)? {
            self.check_wait(cancel, started)?;
        }
        Ok(packets)
    }

    pub(crate) fn finish(
        &mut self,
        cancel: &AtomicBool,
    ) -> Result<Vec<EncodedPacket>, EncodeError> {
        let result = self.drain(cancel);
        if let Err(error) = &result {
            self.terminate(matches!(error, EncodeError::Cancelled));
        }
        result
    }

    fn drain(&mut self, cancel: &AtomicBool) -> Result<Vec<EncodedPacket>, EncodeError> {
        let started = Instant::now();
        self.check_wait(cancel, started)?;
        if self.statistics.accepted_frames != self.frames || self.draining {
            return Err(EncodeError::Invalid(
                "cannot finish an incomplete or draining encoder".into(),
            ));
        }
        unsafe {
            let active = self
                .active
                .as_ref()
                .ok_or_else(|| EncodeError::Invalid("encoder closed".into()))?;
            active
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
            active
                .transform
                .ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
        }
        self.draining = true;
        let mut packets = Vec::new();
        let mut bytes = 0;
        while !self.statistics.drain_completed {
            self.check_wait(cancel, started)?;
            if !self.poll(&mut packets, &mut bytes)? {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        unsafe {
            self.active
                .as_ref()
                .ok_or_else(|| EncodeError::Invalid("encoder closed".into()))?
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0)?;
        }
        self.active.take();
        while !self.gpu_leases.is_empty() {
            if cancel.load(Ordering::Acquire) {
                return Err(EncodeError::Cancelled);
            }
            if started.elapsed() >= Duration::from_millis(self.options.encoder_timeout_ms) {
                return Err(EncodeError::TimedOut);
            }
            self.retire_gpu_leases();
            std::thread::sleep(Duration::from_millis(1));
        }
        Ok(packets)
    }

    fn check_wait(&self, cancel: &AtomicBool, started: Instant) -> Result<(), EncodeError> {
        if cancel.load(Ordering::Acquire) {
            return Err(EncodeError::Cancelled);
        }
        if self.active.is_none() {
            return Err(EncodeError::Invalid("encoder is already closed".into()));
        }
        if started.elapsed() >= Duration::from_millis(self.options.encoder_timeout_ms) {
            return Err(EncodeError::TimedOut);
        }
        Ok(())
    }

    fn poll(
        &mut self,
        packets: &mut Vec<EncodedPacket>,
        bytes: &mut u64,
    ) -> Result<bool, EncodeError> {
        self.retire_gpu_leases();
        unsafe {
            let event = match self.events.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                Ok(event) => event,
                Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => return Ok(false),
                Err(error) => return Err(error.into()),
            };
            event.GetStatus()?.ok()?;
            let kind = event.GetType()?;
            if kind == METransformNeedInput.0 as u32 {
                self.credits = self
                    .credits
                    .checked_add(1)
                    .ok_or_else(|| EncodeError::Platform("input credit overflow".into()))?;
            } else if kind == METransformHaveOutput.0 as u32 {
                if self.statistics.encoded_frames >= self.statistics.accepted_frames {
                    return Err(EncodeError::Platform(
                        "hardware encoder emitted an unexpected frame".into(),
                    ));
                }
                let maximum =
                    u32::try_from(self.options.max_encoder_batch_bytes.saturating_sub(*bytes))
                        .map_err(|_| EncodeError::Invalid("encoder batch size".into()))?
                        .min(self.options.max_encoder_packet_bytes);
                let packet = MfPacket::output(
                    &self
                        .active
                        .as_ref()
                        .ok_or_else(|| EncodeError::Invalid("encoder closed".into()))?
                        .transform,
                    &self.video,
                    self.statistics.encoded_frames,
                    maximum,
                )?;
                self.statistics.encoded_frames += 1;
                self.statistics.encoded_bytes += packet.bytes.len() as u64;
                *bytes += packet.bytes.len() as u64;
                packets.push(packet);
            } else if kind == METransformDrainComplete.0 as u32 {
                if !self.draining || self.statistics.encoded_frames != self.frames {
                    return Err(EncodeError::Platform(
                        "hardware drain dropped or duplicated frames".into(),
                    ));
                }
                self.statistics.drain_completed = true;
            }
            Ok(true)
        }
    }

    fn retire_gpu_leases(&mut self) {
        let before = self.gpu_leases.len();
        self.gpu_leases.retain(|frame, lease| {
            *frame >= self.statistics.encoded_frames || !lease.released.load(Ordering::Acquire)
        });
        self.statistics.retired_gpu_frames += (before - self.gpu_leases.len()) as u64;
    }

    fn terminate(&mut self, cancelled: bool) {
        if let Some(active) = self.active.take() {
            unsafe {
                let _ = active
                    .transform
                    .ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
                let _ = active
                    .transform
                    .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            }
            self.statistics.cancelled = cancelled;
        }
        self.gpu_leases.clear();
    }

    pub(crate) fn cancel(&mut self) {
        self.terminate(true);
    }
}

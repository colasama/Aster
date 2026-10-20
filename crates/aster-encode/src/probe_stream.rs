use std::{
    mem::ManuallyDrop,
    ptr,
    time::{Duration, Instant},
};

use aster_render_ir::ExportVideoConfig;
use windows::Win32::Media::MediaFoundation::*;

use crate::{EncodedProbeProof, EncoderProbeLimits, media_foundation::ActiveTransform};

/// The activation owns shutdown on every exit, including timeout and malformed output.
pub(crate) struct ProbeStream;

impl ProbeStream {
    pub(crate) fn verify(
        encoder: &mut ActiveTransform,
        video: &ExportVideoConfig,
        limits: &EncoderProbeLimits,
        gpu: Option<&crate::mf_gpu::GpuInputDevice>,
    ) -> Result<EncodedProbeProof, Box<dyn std::error::Error>> {
        let transform = &encoder.transform;
        let deadline = Duration::from_millis(limits.encoder_probe_timeout_ms);
        let started = Instant::now();
        if gpu.is_some()
            && u64::from(video.size.width) * u64::from(video.size.height) * 3 / 2
                * u64::from(limits.encoder_probe_frames)
                > limits.max_encoder_input_bytes
        {
            return Err("GPU encoder probe exceeds retained input budget".into());
        }
        let mut proof = EncodedProbeProof {
            frames: 0,
            packets: 0,
            encoded_bytes: 0,
            ordered_timestamps: false,
            annex_b: false,
            drain_completed: false,
        };
        unsafe {
            let info = transform.GetOutputStreamInfo(0)?;
            if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                return Err("hardware encoder must provide bounded output samples".into());
            }
            let events = encoder
                .events
                .as_ref()
                .ok_or("encoder event subscription missing")?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
            tracing::debug!(phase = "stream-start", "Starting encoder qualification");
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
            let mut draining = false;
            loop {
                if started.elapsed() >= deadline {
                    return Err("hardware test frame or drain timed out".into());
                }
                let event = match events.poll()? {
                    Some(event) => event,
                    None => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                };
                let kind = event;
                if kind == METransformNeedInput.0 as u32 && !draining {
                    tracing::debug!(
                        phase = "input",
                        frame = proof.frames,
                        "Submitting qualification sample"
                    );
                    let sample = if let Some(gpu) = gpu {
                        gpu.probe_sample(video, proof.frames)?
                    } else {
                        Self::sample(video, proof.frames)?
                    };
                    transform.ProcessInput(0, &sample, 0)?;
                    tracing::debug!(
                        phase = "input-accepted",
                        frame = proof.frames,
                        "Submitted qualification sample"
                    );
                    if gpu.is_some() {
                        // Retain test surfaces until explicit transform shutdown. The total
                        // probe allocation is bounded independently of production leases.
                        encoder.probe_inputs.push(sample);
                    }
                    proof.frames += 1;
                    if proof.frames == limits.encoder_probe_frames {
                        tracing::debug!(phase = "drain", "Draining encoder qualification");
                        transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0)?;
                        transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0)?;
                        draining = true;
                    }
                } else if kind == METransformHaveOutput.0 as u32 {
                    tracing::debug!(
                        phase = "output",
                        frame = proof.packets,
                        "Receiving qualification packet"
                    );
                    let mut outputs = [MFT_OUTPUT_DATA_BUFFER::default()];
                    let mut status = 0;
                    let result = transform.ProcessOutput(0, &mut outputs, &mut status);
                    let sample = ManuallyDrop::take(&mut outputs[0].pSample);
                    drop(ManuallyDrop::take(&mut outputs[0].pEvents));
                    result?;
                    let sample = sample.ok_or("hardware output sample missing")?;
                    if proof.packets >= proof.frames
                        || sample.GetSampleTime()? != Self::time(video, proof.packets)
                    {
                        return Err("hardware output is reordered, duplicated or has an unexpected timestamp".into());
                    }
                    let length = sample.GetTotalLength()?;
                    if length < 5 || u64::from(length) > limits.max_encoder_input_bytes {
                        return Err("hardware packet size exceeds limits".into());
                    }
                    // Bound all buffers before asking Media Foundation to combine them.
                    let bytes = sample.ConvertToContiguousBuffer()?;
                    let mut data = ptr::null_mut();
                    let mut actual = 0;
                    bytes.Lock(&mut data, None, Some(&mut actual))?;
                    let valid = if actual == length && !data.is_null() {
                        let prefix = std::slice::from_raw_parts(data, 4);
                        prefix.starts_with(&[0, 0, 1]) || prefix == [0, 0, 0, 1]
                    } else {
                        false
                    };
                    bytes.Unlock()?;
                    if !valid {
                        return Err("hardware output is not bounded Annex-B".into());
                    }
                    proof.packets += 1;
                    proof.encoded_bytes += u64::from(length);
                } else if kind == METransformDrainComplete.0 as u32 {
                    tracing::debug!(phase = "drained", "Drained encoder qualification");
                    if !draining || proof.packets != limits.encoder_probe_frames {
                        return Err("hardware drain dropped frames".into());
                    }
                    // A drained transform can start another input stream without releasing
                    // its device resources. The owner shuts it down after its final use.
                    proof.ordered_timestamps = true;
                    proof.annex_b = true;
                    proof.drain_completed = true;
                    return Ok(proof);
                }
            }
        }
    }

    fn time(video: &ExportVideoConfig, frame: u32) -> i64 {
        (u64::from(frame) * 10_000_000 * u64::from(video.frame_rate.denominator)
            / u64::from(video.frame_rate.numerator)) as i64
    }

    fn sample(video: &ExportVideoConfig, frame: u32) -> windows::core::Result<IMFSample> {
        let pixels = u64::from(video.size.width) * u64::from(video.size.height);
        let length = (pixels * 3 / 2) as u32;
        unsafe {
            let buffer = MFCreateMemoryBuffer(length)?;
            let mut data = ptr::null_mut();
            buffer.Lock(&mut data, None, None)?;
            // A moving luma pattern exercises inter-frame encoding without a color conversion.
            let bytes = std::slice::from_raw_parts_mut(data, length as usize);
            for (index, value) in bytes[..pixels as usize].iter_mut().enumerate() {
                *value = 16 + ((index as u32 % video.size.width + frame * 11) % 220) as u8;
            }
            bytes[pixels as usize..].fill(128);
            buffer.Unlock()?;
            buffer.SetCurrentLength(length)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(Self::time(video, frame))?;
            sample.SetSampleDuration(Self::time(video, frame + 1) - Self::time(video, frame))?;
            Ok(sample)
        }
    }
}

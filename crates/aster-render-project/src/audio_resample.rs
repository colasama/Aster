/*
 * Copyright (C) 2011 Google Inc. All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1.  Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
 *     its contributors may be used to endorse or promote products derived
 *     from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
// The compatibility coefficients, phase progression and reduction order follow Blink's
// SincResampler at Chromium 150.0.7871.250. See THIRD_PARTY_LICENSES.md for attribution.
use crate::ProjectRenderError;
use aster_eval::AudioPcm;
use aster_video::{AudioSampleFormat, CancellationToken};

pub(crate) struct AudioResampler {
    ratio: f64,
    kernels: [[f32; 32]; 33],
}

impl AudioResampler {
    /// Chromium normalizes positive integer PCM by its positive full-scale value.
    pub fn normalize(value: f32, format: AudioSampleFormat) -> f32 {
        if value <= 0. {
            return value;
        }
        match format {
            AudioSampleFormat::Unsigned8 => (value * 128.) * (1_f32 / 127.),
            AudioSampleFormat::Signed16 => (value * 32768.) * (1_f32 / 32767.),
            _ => value,
        }
    }

    pub fn convert(
        input: AudioPcm,
        rate: u32,
        budget: usize,
        cancellation: &CancellationToken,
    ) -> Result<AudioPcm, ProjectRenderError> {
        input.validate(budget)?;
        if !(8000..=192000).contains(&rate) {
            return Err(ProjectRenderError::Invalid(
                "audio resample rate outside bounds".into(),
            ));
        }
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if input.sample_rate == rate {
            return Ok(input);
        }
        let ratio = f64::from(input.sample_rate) / f64::from(rate);
        let frames = (input.channels[0].len() as f64 / ratio).floor();
        if frames > (budget / 4 / input.channels.len()) as f64 {
            return Err(ProjectRenderError::Invalid(
                "resampled audio exceeds PCM budget".into(),
            ));
        }
        let cutoff = 0.9 / ratio.max(1.);
        let mut kernels = [[0_f32; 32]; 33];
        for (phase, kernel) in kernels.iter_mut().enumerate() {
            let shift = phase as f64 / 32.;
            for (tap, value) in kernel.iter_mut().enumerate() {
                let position = cutoff * std::f64::consts::PI * (tap as f64 - 16. - shift);
                let sinc = if position == 0. {
                    1.
                } else {
                    position.sin() / position
                };
                let x = (tap as f64 - shift) / 32.;
                let window = 0.5 * (1. - 0.16) - 0.5 * (std::f64::consts::TAU * x).cos()
                    + 0.08 * (std::f64::consts::TAU * 2. * x).cos();
                *value = (sinc * cutoff * window) as f32;
            }
        }
        let resampler = Self { ratio, kernels };
        let channels = input
            .channels
            .into_iter()
            .map(|source| resampler.channel(&source, frames as usize, cancellation))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(AudioPcm {
            sample_rate: rate,
            channels,
        })
    }

    fn channel(
        &self,
        source: &[f32],
        frames: usize,
        cancellation: &CancellationToken,
    ) -> Result<Vec<f32>, ProjectRenderError> {
        let mut output = Vec::with_capacity(frames);
        let mut phase = 0_f64;
        let mut base = 0_i64;
        for frame in 0..frames {
            if frame.is_multiple_of(512) && cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            // Resetting phase at the retained input-block boundary avoids long-source drift.
            while phase >= 512. {
                phase -= 512.;
                base += 512;
            }
            let index = phase as usize;
            let offset = (phase - index as f64) * 32.;
            let kernel = offset as usize;
            let blend = offset - kernel as f64;
            let mut sums = [0_f32; 2];
            let prefix = (4 - index % 4) % 4;
            let parallel_end = prefix + (32 - prefix) / 4 * 4;
            let mut lanes = [[0_f32; 4]; 2];
            for tap in 0..32 {
                let position = base + index as i64 + tap as i64 - 16;
                let sample = usize::try_from(position)
                    .ok()
                    .and_then(|i| source.get(i))
                    .copied()
                    .map_or(0., |v| v);
                for side in 0..2 {
                    let product = sample * self.kernels[kernel + side][tap];
                    if tap < prefix || tap >= parallel_end {
                        sums[side] += product;
                    } else {
                        lanes[side][(tap - prefix) % 4] += product;
                    }
                }
                if tap + 1 == parallel_end {
                    for side in 0..2 {
                        sums[side] +=
                            ((lanes[side][0] + lanes[side][1]) + lanes[side][2]) + lanes[side][3];
                    }
                }
            }
            output.push(((1. - blend) * f64::from(sums[0]) + blend * f64::from(sums[1])) as f32);
            phase += self.ratio;
        }
        Ok(output)
    }
}

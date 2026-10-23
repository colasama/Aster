use crate::{NativeProjectAudio, ProjectExportControl, ProjectExportSchedule, ProjectRenderError};
use aster_eval::{AudioMixRequest, ClipProtection};
use aster_video::{AudioEncoder, AudioMuxSpec};
use std::{fs, io::Write, path::PathBuf};

pub(crate) struct ExportAudio {
    directory: PathBuf,
    pub spec: Option<AudioMuxSpec>,
    pub frames: u64,
    owned: bool,
}

impl ExportAudio {
    pub fn prepare(
        audio: &NativeProjectAudio,
        schedule: &ProjectExportSchedule,
        control: &ProjectExportControl,
        maximum_bytes: u64,
        enabled: bool,
    ) -> Result<Self, ProjectRenderError> {
        let mut output = Self {
            directory: std::env::temp_dir()
                .join(format!("aster-export-audio-{}", uuid::Uuid::new_v4())),
            spec: None,
            frames: 0,
            owned: false,
        };
        if !enabled || audio.receipts.is_empty() {
            return Ok(output);
        }
        let rate = schedule.video.frame_rate;
        let frames = (schedule.frames.len() as f64 / f64::from(rate.numerator)
            * f64::from(rate.denominator)
            * 48_000.)
            .round() as u128;
        let bytes = frames
            .checked_mul(8)
            .filter(|bytes| {
                *bytes <= u128::from(u32::MAX - 36) && *bytes + 44 <= u128::from(maximum_bytes)
            })
            .ok_or_else(|| {
                ProjectRenderError::Invalid("export audio staging exceeds byte budget".into())
            })? as u32;
        fs::create_dir(&output.directory)?;
        output.owned = true;
        let path = output.directory.join("mix.wav");
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)?;
        file.write_all(b"RIFF")?;
        file.write_all(&(bytes + 36).to_le_bytes())?;
        file.write_all(b"WAVEfmt ")?;
        file.write_all(&16_u32.to_le_bytes())?;
        file.write_all(&3_u16.to_le_bytes())?;
        file.write_all(&2_u16.to_le_bytes())?;
        file.write_all(&48_000_u32.to_le_bytes())?;
        file.write_all(&384_000_u32.to_le_bytes())?;
        file.write_all(&8_u16.to_le_bytes())?;
        file.write_all(&32_u16.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(&bytes.to_le_bytes())?;
        let frames = frames as u64;
        let mut done = 0_u64;
        while done < frames {
            control.wait()?;
            let count = (frames - done).min(48_000) as usize;
            let start = schedule.start_time + done as f64 / 48_000.;
            let end = (schedule.start_time + (done as f64 + count as f64) / 48_000.)
                .min(schedule.composition_duration);
            let mut pcm = vec![0_f32; count * 2];
            if start < end {
                let mix = audio.mix(
                    &AudioMixRequest {
                        start_time: start,
                        end_time: end,
                        sample_rate: 48_000,
                        master_level_db: 0.,
                        clip_protection: ClipProtection::Limit,
                    },
                    &control.cancellation,
                )?;
                let length = pcm.len().min(mix.samples.len());
                pcm[..length].copy_from_slice(&mix.samples[..length]);
            }
            let mut encoded = Vec::with_capacity(pcm.len() * 4);
            for sample in pcm {
                encoded.extend_from_slice(&sample.to_le_bytes());
            }
            file.write_all(&encoded)?;
            done += count as u64;
        }
        file.sync_all()?;
        output.frames = frames;
        output.spec = Some(AudioMuxSpec {
            source_path: path,
            stream_index: 0,
            encoder: AudioEncoder::Aac,
            bitrate_bps: 192_000,
            sample_rate_hz: 48_000,
            channels: 2,
        });
        Ok(output)
    }
}

impl Drop for ExportAudio {
    fn drop(&mut self) {
        if self.owned {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }
}

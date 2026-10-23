use super::{
    AudioMuxSpec, ExportContainer, ExportError, ExportFrameReceiver, ExportLimits,
    FfmpegExportBackend, FrameEncoding,
};
use crate::{CancellationToken, FfmpegCommand};
use aster_storage::AtomicFile;
use std::{
    ffi::OsString,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// One ordered Annex-B access unit per frame, produced by an independently validated encoder.
#[derive(Clone, Debug)]
pub struct EncodedVideoExportRequest {
    pub output_path: PathBuf,
    pub frame_rate_numerator: u32,
    pub frame_rate_denominator: u32,
    pub frame_count: u64,
    pub maximum_packet_bytes: usize,
    pub audio: Option<AudioMuxSpec>,
}

#[derive(Clone, Debug)]
pub struct EncodedVideoExportReport {
    pub output_path: PathBuf,
    pub frame_count: u64,
    pub bytes_written: u64,
    pub elapsed: Duration,
}

impl EncodedVideoExportRequest {
    /// Validate before starting a producer so mux rejection cannot appear as a closed channel.
    pub fn validate(&self, limits: &ExportLimits) -> Result<f64, ExportError> {
        limits.validate_output_path(&self.output_path, ExportContainer::Mp4)?;
        if self.frame_rate_numerator == 0
            || self.frame_rate_denominator == 0
            || self.frame_count == 0
            || self.frame_count > limits.max_frame_count
            || self.maximum_packet_bytes == 0
            || self.maximum_packet_bytes as u64 > limits.max_frame_bytes
        {
            return Err(ExportError::InvalidRequest(
                "invalid encoded frame count, rate or packet budget".into(),
            ));
        }
        let fps = f64::from(self.frame_rate_numerator) / f64::from(self.frame_rate_denominator);
        let duration = self.frame_count as f64 / fps;
        if !(1.0..=240.0).contains(&fps)
            || !duration.is_finite()
            || duration > limits.max_duration.as_secs_f64()
        {
            return Err(ExportError::InvalidRequest(
                "encoded frame rate or duration exceeds bounds".into(),
            ));
        }
        self.frame_count
            .checked_mul(u64::from(self.frame_rate_denominator))
            .filter(|ticks| *ticks <= i64::MAX as u64)
            .ok_or_else(|| ExportError::InvalidRequest("encoded timestamp overflow".into()))?;
        if let Some(audio) = &self.audio {
            audio.validate(ExportContainer::Mp4, limits)?;
        }
        Ok(duration)
    }

    fn command(&self, executable: &Path, destination: &Path, duration: f64) -> FfmpegCommand {
        let mut args: Vec<OsString> = vec![
            "-hide_banner".into(),
            "-v".into(),
            "error".into(),
            "-nostdin".into(),
            "-r".into(),
            format!(
                "{}/{}",
                self.frame_rate_numerator, self.frame_rate_denominator
            )
            .into(),
            "-f".into(),
            "h264".into(),
            "-i".into(),
            "pipe:0".into(),
        ];
        if let Some(audio) = &self.audio {
            args.extend(["-i".into(), audio.source_path.as_os_str().to_owned()]);
        }
        let timestamps = format!(
            "setts=ts=N*{}:duration={}:time_base=1/{}",
            self.frame_rate_denominator, self.frame_rate_denominator, self.frame_rate_numerator
        );
        let bitstream = format!(
            "{timestamps},h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1"
        );
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-c:v".into(),
            "copy".into(),
            "-sn".into(),
            "-dn".into(),
            "-color_range".into(),
            "tv".into(),
            "-colorspace".into(),
            "bt709".into(),
            "-color_primaries".into(),
            "bt709".into(),
            "-color_trc".into(),
            "bt709".into(),
            "-bsf:v".into(),
            bitstream.into(),
            "-frames:v".into(),
            self.frame_count.to_string().into(),
        ]);
        if let Some(audio) = &self.audio {
            args.extend([
                "-map".into(),
                format!("1:a:{}", audio.stream_index).into(),
                "-c:a".into(),
                audio.encoder.ffmpeg_name().into(),
                "-b:a".into(),
                audio.bitrate_bps.to_string().into(),
                "-ar".into(),
                audio.sample_rate_hz.to_string().into(),
                "-ac".into(),
                audio.channels.to_string().into(),
                "-t".into(),
                format!("{duration:.9}").into(),
            ]);
        } else {
            args.push("-an".into());
        }
        args.extend([
            "-movflags".into(),
            "+faststart".into(),
            "-f".into(),
            "mp4".into(),
            "-y".into(),
            destination.as_os_str().to_owned(),
        ]);
        FfmpegCommand::new(executable.to_owned(), args)
    }
}

impl FfmpegExportBackend {
    /// Copy encoded H.264 into MP4 without decoding or re-encoding the native GPU output.
    pub fn mux_h264(
        &self,
        request: &EncodedVideoExportRequest,
        packets: ExportFrameReceiver,
        cancellation: &CancellationToken,
    ) -> Result<EncodedVideoExportReport, ExportError> {
        let duration = request.validate(&self.limits)?;
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        let (temporary, file) = AtomicFile::stage(&request.output_path)?;
        drop(file);
        let command = request.command(&self.executable, &temporary.temporary, duration);
        let started = Instant::now();
        self.run_export(
            &command,
            packets,
            FrameEncoding::AnnexB {
                maximum_bytes: request.maximum_packet_bytes,
            },
            request.frame_count,
            cancellation,
        )?;
        if cancellation.is_cancelled() {
            return Err(ExportError::Cancelled);
        }
        let bytes_written = fs::metadata(&temporary.temporary)?.len();
        if bytes_written == 0 {
            return Err(ExportError::Publish(
                "muxer produced an empty output".into(),
            ));
        }
        temporary.publish(false).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                ExportError::OutputExists(request.output_path.clone())
            } else {
                ExportError::Publish(error.to_string())
            }
        })?;
        Ok(EncodedVideoExportReport {
            output_path: request.output_path.clone(),
            frame_count: request.frame_count,
            bytes_written,
            elapsed: started.elapsed(),
        })
    }
}

#[cfg(test)]
mod tests;

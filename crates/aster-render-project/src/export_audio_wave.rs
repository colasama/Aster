use crate::ProjectRenderError;
use std::io::Write;

/// Float stereo WAV keeps short output byte-identical and uses RF64 for large PCM payloads.
pub(crate) struct ExportAudioWave {
    frames: u64,
    data_bytes: u64,
    pub file_bytes: u64,
    rf64: bool,
}

impl ExportAudioWave {
    pub fn new(frames: u64, maximum_bytes: u64) -> Result<Self, ProjectRenderError> {
        let data_bytes = frames.checked_mul(8).ok_or_else(|| {
            ProjectRenderError::Invalid("export audio byte count overflow".into())
        })?;
        let rf64 = data_bytes > u64::from(u32::MAX - 36);
        let file_bytes = data_bytes
            .checked_add(if rf64 { 80 } else { 44 })
            .filter(|bytes| *bytes <= maximum_bytes)
            .ok_or_else(|| {
                ProjectRenderError::Invalid("export audio staging exceeds byte budget".into())
            })?;
        Ok(Self {
            frames,
            data_bytes,
            file_bytes,
            rf64,
        })
    }

    pub fn write_header(&self, file: &mut impl Write) -> Result<(), std::io::Error> {
        if self.rf64 {
            file.write_all(b"RF64")?;
            file.write_all(&u32::MAX.to_le_bytes())?;
            file.write_all(b"WAVEds64")?;
            file.write_all(&28_u32.to_le_bytes())?;
            file.write_all(&(self.file_bytes - 8).to_le_bytes())?;
            file.write_all(&self.data_bytes.to_le_bytes())?;
            file.write_all(&self.frames.to_le_bytes())?;
            file.write_all(&0_u32.to_le_bytes())?;
        } else {
            file.write_all(b"RIFF")?;
            file.write_all(&((self.file_bytes - 8) as u32).to_le_bytes())?;
            file.write_all(b"WAVE")?;
        }
        file.write_all(b"fmt ")?;
        file.write_all(&16_u32.to_le_bytes())?;
        file.write_all(&3_u16.to_le_bytes())?;
        file.write_all(&2_u16.to_le_bytes())?;
        file.write_all(&48_000_u32.to_le_bytes())?;
        file.write_all(&384_000_u32.to_le_bytes())?;
        file.write_all(&8_u16.to_le_bytes())?;
        file.write_all(&32_u16.to_le_bytes())?;
        file.write_all(b"data")?;
        file.write_all(
            &(if self.rf64 {
                u32::MAX
            } else {
                self.data_bytes as u32
            })
            .to_le_bytes(),
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wave_headers_cross_the_riff_boundary_without_narrowing_sizes()
    -> Result<(), Box<dyn std::error::Error>> {
        for frames in [
            1,
            48_000,
            u64::from(u32::MAX - 36) / 8,
            u64::from(u32::MAX - 36) / 8 + 1,
        ] {
            let wave = ExportAudioWave::new(frames, u64::MAX)?;
            let mut header = Vec::new();
            wave.write_header(&mut header)?;
            assert_eq!(header.len() as u64 + frames * 8, wave.file_bytes);
            if wave.rf64 {
                assert_eq!(&header[..4], b"RF64");
                assert_eq!(
                    u64::from_le_bytes(header[20..28].try_into()?),
                    wave.file_bytes - 8
                );
                assert_eq!(u64::from_le_bytes(header[28..36].try_into()?), frames * 8);
                assert_eq!(u64::from_le_bytes(header[36..44].try_into()?), frames);
            } else {
                assert_eq!(&header[..4], b"RIFF");
                assert_eq!(header.len(), 44);
            }
            assert!(ExportAudioWave::new(frames, wave.file_bytes - 1).is_err());
        }
        assert!(ExportAudioWave::new(u64::MAX, u64::MAX).is_err());
        Ok(())
    }

    #[test]
    #[ignore = "requires an explicit directory for packaged FFmpeg RF64 qualification"]
    fn write_sparse_audio_qualification_files() -> Result<(), Box<dyn std::error::Error>> {
        #[derive(serde::Serialize)]
        struct Case {
            name: String,
            path: std::path::PathBuf,
            frames: u64,
            bytes: u64,
        }
        let directory = std::path::PathBuf::from(std::env::var("ASTER_EXPORT_AUDIO_WAVE_DIR")?);
        std::fs::create_dir_all(&directory)?;
        let mut cases = Vec::new();
        for (name, frames) in [("riff", 48_000_u64), ("rf64", 536_870_913_u64)] {
            let wave = ExportAudioWave::new(frames, 1_099_511_627_776)?;
            let path = directory.join(format!("{name}.wav"));
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let status = std::process::Command::new("fsutil.exe")
                    .args(["sparse", "setflag"])
                    .arg(&path)
                    .creation_flags(0x08000000)
                    .output()?;
                if !status.status.success() {
                    return Err("could not mark private qualification file sparse".into());
                }
            }
            wave.write_header(&mut file)?;
            file.set_len(wave.file_bytes)?;
            file.sync_all()?;
            cases.push(Case {
                name: name.into(),
                path,
                frames,
                bytes: wave.file_bytes,
            });
        }
        std::fs::write(
            directory.join("cases.json"),
            serde_json::to_vec_pretty(&cases)?,
        )?;
        Ok(())
    }
}

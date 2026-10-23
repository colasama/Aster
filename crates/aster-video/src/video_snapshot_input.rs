use crate::{CancellationToken, FfmpegError};
use aster_storage::AtomicFile;
use std::{
    fs::File,
    io::{self, Write},
};

/// Private seekable input; its writer closes before the staging owner deletes the file.
pub struct VideoSnapshotInput {
    writer: File,
    file: AtomicFile,
    bytes: u64,
    maximum: u64,
    cancellation: CancellationToken,
}

impl VideoSnapshotInput {
    pub fn new(maximum: u64, cancellation: CancellationToken) -> Result<Self, FfmpegError> {
        if cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        if maximum == 0 || maximum == u64::MAX {
            return Err(FfmpegError::MediaTooLarge { limit: maximum });
        }
        let (file, writer) =
            AtomicFile::stage(&std::env::temp_dir().join("aster-video-snapshot.mp4"))
                .map_err(|error| FfmpegError::ProcessIo(error.to_string()))?;
        Ok(Self {
            writer,
            file,
            bytes: 0,
            maximum,
            cancellation,
        })
    }

    pub(crate) fn into_file(self, maximum: u64) -> Result<AtomicFile, FfmpegError> {
        if self.cancellation.is_cancelled() {
            return Err(FfmpegError::Cancelled);
        }
        if self.bytes == 0 || self.bytes > maximum {
            return Err(FfmpegError::MediaTooLarge { limit: maximum });
        }
        let Self { writer, file, .. } = self;
        drop(writer);
        Ok(file)
    }
}

impl Write for VideoSnapshotInput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if self.cancellation.is_cancelled() {
            return Err(io::Error::other("video snapshot cancelled"));
        }
        if self
            .bytes
            .checked_add(bytes.len() as u64)
            .is_none_or(|n| n > self.maximum)
        {
            return Err(io::Error::other(
                "video snapshot exceeds source byte budget",
            ));
        }
        let written = self.writer.write(bytes)?;
        self.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staged_video_input_enforces_budgets_cancellation_and_cleanup()
    -> Result<(), Box<dyn std::error::Error>> {
        let cancellation = CancellationToken::default();
        let mut input = VideoSnapshotInput::new(4, cancellation.clone())?;
        let path = input.file.temporary.clone();
        input.write_all(b"1234")?;
        assert!(input.write_all(b"5").is_err());
        assert_eq!(std::fs::read(&path)?, b"1234");
        cancellation.cancel();
        assert!(input.write_all(b"x").is_err());
        assert!(matches!(input.into_file(4), Err(FfmpegError::Cancelled)));
        assert!(!path.try_exists()?);
        let input = VideoSnapshotInput::new(4, CancellationToken::default())?;
        let path = input.file.temporary.clone();
        assert!(input.into_file(4).is_err());
        assert!(!path.try_exists()?);
        let mut input = VideoSnapshotInput::new(4, CancellationToken::default())?;
        let path = input.file.temporary.clone();
        input.write_all(b"1234")?;
        let staged = input.into_file(4)?;
        assert_eq!(std::fs::read(&staged.temporary)?, b"1234");
        drop(staged);
        assert!(!path.try_exists()?);
        Ok(())
    }
}

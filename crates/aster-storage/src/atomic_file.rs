use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};

use uuid::Uuid;

/// Owns an unpublished sibling file until a complete, synced write replaces its destination.
#[derive(Debug)]
pub struct AtomicFile {
    pub temporary: PathBuf,
    destination: PathBuf,
}

impl AtomicFile {
    pub fn write<E: From<io::Error>>(
        destination: &Path,
        write: impl FnOnce(&mut File) -> Result<(), E>,
    ) -> Result<(), E> {
        let (pending, mut file) = Self::stage(destination)?;
        write(&mut file)?;
        drop(file);
        pending.publish(true)?;
        Ok(())
    }

    /// Creates an unpublished file that can be inspected before publication.
    pub fn stage(destination: &Path) -> io::Result<(Self, File)> {
        let parent = destination
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".aster-{}.tmp", Uuid::new_v4()));
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        // Ownership starts only after create_new succeeds; a collision belongs to another writer.
        let pending = Self {
            temporary,
            destination: destination.to_owned(),
        };
        Ok((pending, file))
    }

    /// Publishes complete bytes, optionally preserving any existing destination.
    pub fn publish(self, overwrite: bool) -> io::Result<()> {
        File::options()
            .write(true)
            .open(&self.temporary)?
            .sync_all()?;
        // A single rename keeps the previous file visible until its replacement is ready.
        if overwrite {
            fs::rename(&self.temporary, &self.destination)?;
        } else {
            // Hard-link creation fails if another writer has already claimed the name.
            fs::hard_link(&self.temporary, &self.destination)?;
        }
        Ok(())
    }
}

impl Drop for AtomicFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary);
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;

    #[test]
    fn failed_writes_preserve_the_published_file_and_clean_staging() -> io::Result<()> {
        let directory = std::env::temp_dir().join(format!("aster-atomic-{}", Uuid::new_v4()));
        let destination = directory.join("document.json");
        AtomicFile::write(&destination, |file| file.write_all(b"original"))?;
        let result: io::Result<()> = AtomicFile::write(&destination, |file| {
            file.write_all(b"partial")?;
            assert_eq!(fs::read(&destination)?, b"original");
            Err(io::Error::other("interrupted writer"))
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&destination)?, b"original");
        assert_eq!(fs::read_dir(&directory)?.count(), 1);
        AtomicFile::write(&destination, |file| file.write_all(b"replacement"))?;
        assert_eq!(fs::read(&destination)?, b"replacement");
        assert_eq!(fs::read_dir(&directory)?.count(), 1);
        fs::remove_dir_all(directory)
    }

    #[test]
    fn publication_without_overwrite_preserves_a_concurrent_writer() -> io::Result<()> {
        let directory = std::env::temp_dir().join(format!("aster-atomic-{}", Uuid::new_v4()));
        let destination = directory.join("asset");
        let (pending, mut file) = AtomicFile::stage(&destination)?;
        file.write_all(b"staged")?;
        drop(file);
        fs::write(&destination, b"other writer")?;
        assert!(pending.publish(false).is_err());
        assert_eq!(fs::read(&destination)?, b"other writer");
        assert_eq!(fs::read_dir(&directory)?.count(), 1);
        fs::remove_dir_all(directory)
    }
}

mod atomic_file;
mod directory;

pub use atomic_file::AtomicFile;
pub use directory::DirectoryPublication;

use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Owns an unpublished directory and removes staging files when the operation ends.
pub struct PendingDirectory {
    pub path: PathBuf,
}

impl PendingDirectory {
    pub fn create(parent: &Path) -> io::Result<Self> {
        fs::create_dir_all(parent)?;
        let path = parent.join(format!(".aster-{}.staging", uuid::Uuid::new_v4()));
        fs::create_dir(&path)?;
        Ok(Self { path })
    }
}

impl Drop for PendingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

use std::{
    fs::{self, File},
    io,
    path::{Path, PathBuf},
};

/// Serializes directory publication and recovers an interrupted directory replacement.
pub struct DirectoryPublication {
    _lock: File,
    destination: PathBuf,
    backup: PathBuf,
}

impl DirectoryPublication {
    pub fn acquire(destination: &Path) -> io::Result<Self> {
        let parent = destination
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)?;
        let name = destination
            .file_name()
            .ok_or_else(|| io::Error::other("publication requires a directory name"))?;
        let mut lock_name = name.to_os_string();
        lock_name.push(".aster-lock");
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(parent.join(lock_name))?;
        lock.lock()?;
        let mut backup_name = name.to_os_string();
        backup_name.push(".aster-backup");
        let backup = parent.join(backup_name);
        if backup.exists() {
            if destination.exists() {
                fs::remove_dir_all(&backup)?;
            } else {
                fs::rename(&backup, destination)?;
            }
        }
        Ok(Self {
            _lock: lock,
            destination: destination.to_owned(),
            backup,
        })
    }

    pub fn replace(&self, staging: &Path) -> io::Result<()> {
        let replacing = self.destination.exists();
        if replacing {
            fs::rename(&self.destination, &self.backup)?;
        }
        if let Err(error) = fs::rename(staging, &self.destination) {
            if replacing {
                // The stable backup also permits recovery after a process interruption.
                fs::rename(&self.backup, &self.destination)?;
            }
            return Err(error);
        }
        if replacing {
            // Publication succeeded; a retained backup is cleaned on the next access.
            let _ = fs::remove_dir_all(&self.backup);
        }
        Ok(())
    }
}

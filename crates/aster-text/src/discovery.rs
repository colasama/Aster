use std::{
    collections::{BTreeSet, VecDeque},
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::FontId;

#[derive(Clone, Debug, clap::Args)]
pub struct FontDiscoveryConfig {
    #[arg(long, default_value_t = Self::default().max_discovery_files)]
    pub max_discovery_files: usize,
    #[arg(long, default_value_t = Self::default().max_discovery_depth)]
    pub max_discovery_depth: usize,
    #[arg(long, default_value_t = Self::default().max_font_bytes)]
    pub max_font_bytes: u64,
}
impl Default for FontDiscoveryConfig {
    fn default() -> Self {
        Self {
            max_discovery_files: 32_768,
            max_discovery_depth: 8,
            max_font_bytes: 256 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FontContainer {
    OpenType,
    TrueType,
    TrueTypeCollection,
    Woff,
    Woff2,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FontFile {
    pub path: PathBuf,
    pub container: FontContainer,
    pub bytes: u64,
}

#[derive(Clone, Debug)]
pub struct LoadedFont {
    pub id: FontId,
    pub sha256: [u8; 32],
    pub data: Arc<[u8]>,
}

#[derive(Debug, Error)]
pub enum FontDiscoveryError {
    #[error("font discovery limit must be nonzero and within its configured maximum")]
    InvalidLimit,
    #[error("font file is not a regular non-symlink file: {0}")]
    UnsafeFile(PathBuf),
    #[error("font file is empty or exceeds the configured byte limit: {0}")]
    InvalidSize(u64),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

impl FontDiscoveryConfig {
    /// Returns standard system and per-user font roots for the current platform.
    #[must_use]
    pub fn platform_roots() -> Vec<PathBuf> {
        let mut roots = Vec::new();
        if cfg!(target_os = "windows") {
            if let Some(windows) = std::env::var_os("WINDIR") {
                roots.push(PathBuf::from(windows).join("Fonts"));
            }
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                roots.push(
                    PathBuf::from(local)
                        .join("Microsoft")
                        .join("Windows")
                        .join("Fonts"),
                );
            }
        } else if cfg!(target_os = "macos") {
            roots.extend([
                PathBuf::from("/System/Library/Fonts"),
                PathBuf::from("/Library/Fonts"),
            ]);
            if let Some(home) = std::env::var_os("HOME") {
                roots.push(PathBuf::from(home).join("Library").join("Fonts"));
            }
        } else {
            roots.extend([
                PathBuf::from("/usr/share/fonts"),
                PathBuf::from("/usr/local/share/fonts"),
            ]);
            if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
                roots.push(PathBuf::from(data).join("fonts"));
            } else if let Some(home) = std::env::var_os("HOME") {
                roots.push(
                    PathBuf::from(home)
                        .join(".local")
                        .join("share")
                        .join("fonts"),
                );
            }
        }
        roots.sort();
        roots.dedup();
        roots
    }
    /// Discovers font candidates without following directory or file links.
    pub fn discover(
        &self,
        roots: impl IntoIterator<Item = impl AsRef<Path>>,
        limit: usize,
    ) -> Result<Vec<FontFile>, FontDiscoveryError> {
        if !(1..=self.max_discovery_files).contains(&limit) {
            return Err(FontDiscoveryError::InvalidLimit);
        }
        let mut files = Vec::new();
        let mut seen = BTreeSet::new();
        for root in roots {
            if files.len() >= limit {
                break;
            }
            let root = match root.as_ref().canonicalize() {
                Ok(root) => root,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            if !root.is_dir() || !seen.insert(root.clone()) {
                continue;
            }
            let mut pending = VecDeque::from([(root.clone(), 0_usize)]);
            while files.len() < limit {
                let Some((directory, depth)) = pending.pop_front() else {
                    break;
                };
                let mut entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
                entries.sort_by_key(|entry| entry.file_name());
                for entry in entries {
                    if files.len() >= limit {
                        break;
                    }
                    let metadata = fs::symlink_metadata(entry.path())?;
                    if FontFile::is_link(&metadata) {
                        continue;
                    }
                    if metadata.is_dir() {
                        if depth < self.max_discovery_depth {
                            pending.push_back((entry.path(), depth + 1));
                        }
                        continue;
                    }
                    let Some(container) = FontContainer::from_path(&entry.path()) else {
                        continue;
                    };
                    if !metadata.is_file()
                        || metadata.len() == 0
                        || metadata.len() > self.max_font_bytes
                    {
                        continue;
                    }
                    let canonical = entry.path().canonicalize()?;
                    if !canonical.starts_with(&root) || !seen.insert(canonical.clone()) {
                        continue;
                    }
                    files.push(FontFile {
                        path: canonical,
                        container,
                        bytes: metadata.len(),
                    });
                }
            }
        }
        files.sort_by(|left, right| {
            left.path
                .to_string_lossy()
                .to_lowercase()
                .cmp(&right.path.to_string_lossy().to_lowercase())
        });
        Ok(files)
    }
}
impl FontFile {
    pub fn load(&self, config: &FontDiscoveryConfig) -> Result<LoadedFont, FontDiscoveryError> {
        let metadata = fs::symlink_metadata(&self.path)?;
        if !metadata.is_file() || Self::is_link(&metadata) {
            return Err(FontDiscoveryError::UnsafeFile(self.path.clone()));
        }
        if metadata.len() == 0 || metadata.len() > config.max_font_bytes {
            return Err(FontDiscoveryError::InvalidSize(metadata.len()));
        }
        let mut data = Vec::with_capacity(
            usize::try_from(metadata.len())
                .map_err(|_| FontDiscoveryError::InvalidSize(metadata.len()))?,
        );
        File::open(&self.path)?
            .take(config.max_font_bytes.saturating_add(1))
            .read_to_end(&mut data)?;
        if data.is_empty() || data.len() as u64 > config.max_font_bytes {
            return Err(FontDiscoveryError::InvalidSize(data.len() as u64));
        }
        let sha256: [u8; 32] = Sha256::digest(&data).into();
        let mut id_bytes = [0_u8; 8];
        id_bytes.copy_from_slice(&sha256[..8]);
        let id = FontId(u64::from_le_bytes(id_bytes));
        Ok(LoadedFont {
            id,
            sha256,
            data: Arc::from(data),
        })
    }
    fn is_link(metadata: &fs::Metadata) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
        }
        #[cfg(not(windows))]
        {
            metadata.file_type().is_symlink()
        }
    }
}
impl FontContainer {
    fn from_path(path: &Path) -> Option<FontContainer> {
        match path
            .extension()?
            .to_string_lossy()
            .to_ascii_lowercase()
            .as_str()
        {
            "otf" => Some(FontContainer::OpenType),
            "ttf" => Some(FontContainer::TrueType),
            "ttc" | "otc" => Some(FontContainer::TrueTypeCollection),
            "woff" => Some(FontContainer::Woff),
            "woff2" => Some(FontContainer::Woff2),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aster_storage::PendingDirectory;

    #[test]
    fn discovers_supported_files_deterministically_and_loads_content_identity()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = PendingDirectory::create(&std::env::temp_dir())?;
        fs::create_dir(root.path.join("nested"))?;
        fs::write(root.path.join("z.ttf"), b"font-z")?;
        fs::write(root.path.join("nested").join("A.OTF"), b"font-a")?;
        fs::write(root.path.join("ignored.txt"), b"not a font")?;
        fs::write(root.path.join("empty.woff2"), b"")?;

        let files = FontDiscoveryConfig::default().discover([&root.path], 16)?;
        assert_eq!(files.len(), 2);
        assert!(files[0].path.ends_with("A.OTF"));
        assert!(files[1].path.ends_with("z.ttf"));
        let first = files[0].load(&FontDiscoveryConfig::default())?;
        let second = files[1].load(&FontDiscoveryConfig::default())?;
        assert_ne!(first.id, second.id);
        assert_eq!(&*first.data, b"font-a");
        Ok(())
    }

    #[test]
    fn enforces_discovery_and_load_bounds() -> Result<(), Box<dyn std::error::Error>> {
        assert!(matches!(
            FontDiscoveryConfig::default().discover(std::iter::empty::<&Path>(), 0),
            Err(FontDiscoveryError::InvalidLimit)
        ));
        let root = PendingDirectory::create(&std::env::temp_dir())?;
        let path = root.path.join("font.ttf");
        fs::write(&path, b"font")?;
        let candidate = FontFile {
            path: path.clone(),
            container: FontContainer::TrueType,
            bytes: 4,
        };
        fs::write(path, b"")?;
        assert!(matches!(
            candidate.load(&FontDiscoveryConfig::default()),
            Err(FontDiscoveryError::InvalidSize(0))
        ));
        Ok(())
    }
}

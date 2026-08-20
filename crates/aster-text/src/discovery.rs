use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File},
    io::{Read, Take},
    path::{Path, PathBuf},
    sync::Arc,
};

use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::FontId;

const MAX_DISCOVERY_FILES: usize = 32_768;
const MAX_DISCOVERY_DEPTH: usize = 8;
const MAX_FONT_BYTES: u64 = 256 * 1024 * 1024;

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
    #[error("font discovery limit must be between 1 and {MAX_DISCOVERY_FILES}")]
    InvalidLimit,
    #[error("font file is not a regular non-symlink file: {0}")]
    UnsafeFile(PathBuf),
    #[error("font file is empty or exceeds the {MAX_FONT_BYTES}-byte limit: {0}")]
    InvalidSize(u64),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Returns standard system and per-user font roots for the current platform.
#[must_use]
pub fn platform_font_roots() -> Vec<PathBuf> {
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

/// Discovers bounded font candidates without following directory or file symlinks.
pub fn discover_font_files(
    roots: impl IntoIterator<Item = impl AsRef<Path>>,
    limit: usize,
) -> Result<Vec<FontFile>, FontDiscoveryError> {
    if !(1..=MAX_DISCOVERY_FILES).contains(&limit) {
        return Err(FontDiscoveryError::InvalidLimit);
    }
    let mut files = Vec::new();
    let mut seen = HashSet::new();
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
        while let Some((directory, depth)) = pending.pop_front() {
            let mut entries = fs::read_dir(&directory)?.collect::<Result<Vec<_>, _>>()?;
            entries.sort_by_key(|entry| entry.file_name());
            for entry in entries {
                if files.len() >= limit {
                    break;
                }
                let metadata = fs::symlink_metadata(entry.path())?;
                if metadata.file_type().is_symlink() {
                    continue;
                }
                if metadata.is_dir() {
                    if depth < MAX_DISCOVERY_DEPTH {
                        pending.push_back((entry.path(), depth + 1));
                    }
                    continue;
                }
                let Some(container) = font_container(&entry.path()) else {
                    continue;
                };
                if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_FONT_BYTES {
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

pub fn load_font_file(candidate: &FontFile) -> Result<LoadedFont, FontDiscoveryError> {
    let metadata = fs::symlink_metadata(&candidate.path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(FontDiscoveryError::UnsafeFile(candidate.path.clone()));
    }
    if metadata.len() == 0 || metadata.len() > MAX_FONT_BYTES {
        return Err(FontDiscoveryError::InvalidSize(metadata.len()));
    }
    let mut data = Vec::with_capacity(metadata.len() as usize);
    bounded_reader(File::open(&candidate.path)?).read_to_end(&mut data)?;
    if data.is_empty() || data.len() as u64 > MAX_FONT_BYTES {
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

fn bounded_reader(file: File) -> Take<File> {
    file.take(MAX_FONT_BYTES + 1)
}

fn font_container(path: &Path) -> Option<FontContainer> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!("aster-font-discovery-{nonce}"));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovers_supported_files_deterministically_and_loads_content_identity() {
        let root = TestDirectory::new();
        fs::create_dir(root.0.join("nested")).unwrap();
        fs::write(root.0.join("z.ttf"), b"font-z").unwrap();
        fs::write(root.0.join("nested").join("A.OTF"), b"font-a").unwrap();
        fs::write(root.0.join("ignored.txt"), b"not a font").unwrap();
        fs::write(root.0.join("empty.woff2"), b"").unwrap();

        let files = discover_font_files([&root.0], 16).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].path.ends_with("A.OTF"));
        assert!(files[1].path.ends_with("z.ttf"));
        let first = load_font_file(&files[0]).unwrap();
        let second = load_font_file(&files[1]).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(&*first.data, b"font-a");
    }

    #[test]
    fn enforces_discovery_and_load_bounds() {
        assert!(matches!(
            discover_font_files(std::iter::empty::<&Path>(), 0),
            Err(FontDiscoveryError::InvalidLimit)
        ));
        let root = TestDirectory::new();
        let path = root.0.join("font.ttf");
        fs::write(&path, b"font").unwrap();
        let candidate = FontFile {
            path: path.clone(),
            container: FontContainer::TrueType,
            bytes: 4,
        };
        fs::write(path, b"").unwrap();
        assert!(matches!(
            load_font_file(&candidate),
            Err(FontDiscoveryError::InvalidSize(0))
        ));
    }
}

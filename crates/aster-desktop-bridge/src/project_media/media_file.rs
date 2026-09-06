use super::validation::is_link_like;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{BufReader, Read},
    path::{Component, Path, PathBuf},
};

pub(super) struct MediaFiles {
    pub root: PathBuf,
}
impl MediaFiles {
    pub(super) fn existing(&self, relative: &Path, path: &str) -> Result<PathBuf, String> {
        let bundle = &self.root;
        let mut candidate = bundle.to_owned();
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err("project media relativePath must stay inside the bundle".to_owned());
            };
            candidate.push(component);
            let metadata = fs::symlink_metadata(&candidate)
                .map_err(|_| format!("{path} media file is missing from the project bundle"))?;
            if is_link_like(&metadata) {
                return Err(format!(
                    "{path} media path must not contain a link or reparse point"
                ));
            }
        }
        let resolved = candidate
            .canonicalize()
            .map_err(|_| format!("{path} media file is missing from the project bundle"))?;
        if !resolved.starts_with(bundle) {
            return Err(format!(
                "{path} media path resolves outside the project bundle"
            ));
        }
        if !fs::metadata(&resolved)
            .map_err(|error| error.to_string())?
            .is_file()
        {
            return Err(format!("{path} media payload is not a file"));
        }
        Ok(resolved)
    }
    pub(super) fn destination(&self, relative: &Path, path: &str) -> Result<PathBuf, String> {
        let bundle = &self.root;
        let parent = relative
            .parent()
            .ok_or_else(|| format!("{path} media destination has no parent"))?;
        let mut current = bundle.to_owned();
        for component in parent.components() {
            let Component::Normal(component) = component else {
                return Err("project media relativePath must stay inside the bundle".to_owned());
            };
            current.push(component);
            match fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if is_link_like(&metadata) {
                        return Err(format!(
                            "{path} media destination must not contain a link or reparse point"
                        ));
                    }
                    if !metadata.is_dir() {
                        return Err(format!(
                            "{path} media destination parent is not a directory"
                        ));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&current).map_err(|error| error.to_string())?;
                }
                Err(error) => return Err(error.to_string()),
            }
            let resolved = current.canonicalize().map_err(|error| error.to_string())?;
            if !resolved.starts_with(bundle) {
                return Err(format!(
                    "{path} media destination resolves outside the project bundle"
                ));
            }
        }
        let destination = bundle.join(relative);
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if is_link_like(&metadata) {
                return Err(format!(
                    "{path} media destination must not be a link or reparse point"
                ));
            }
            let resolved = destination
                .canonicalize()
                .map_err(|error| error.to_string())?;
            if !resolved.starts_with(bundle) {
                return Err(format!(
                    "{path} media destination resolves outside the project bundle"
                ));
            }
        }
        Ok(destination)
    }
    pub(super) fn import_relative_path(identity: &str, extension: &str) -> PathBuf {
        let digest = Sha256::digest(identity.as_bytes());
        PathBuf::from("assets")
            .join("imports")
            .join(format!("{:x}{extension}", digest))
    }
    pub(super) fn slash_path(path: &Path) -> String {
        path.components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    }
}
pub(crate) struct Fnv64State {
    left: u32,
    right: u32,
    bytes: u64,
}

impl Default for Fnv64State {
    fn default() -> Self {
        Self {
            left: 0x811c9dc5,
            right: 0x9e3779b9,
            bytes: 0,
        }
    }
}

impl Fnv64State {
    fn update(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.left = (self.left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            self.right = (self.right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        self.bytes = self.bytes.saturating_add(bytes.len() as u64);
    }

    fn identity(&self) -> String {
        format!("fnv64:{:08x}{:08x}:{}", self.left, self.right, self.bytes)
    }
}

impl Fnv64State {
    pub(super) fn file_identities(path: &Path, maximum: u64) -> Result<(String, String), String> {
        let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
        let mut state = Fnv64State::default();
        let mut sha256 = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            if state.bytes.saturating_add(count as u64) > maximum {
                return Err("media payload exceeds its size limit".to_owned());
            }
            state.update(&buffer[..count]);
            sha256.update(&buffer[..count]);
        }
        Ok((state.identity(), format!("sha256:{:x}", sha256.finalize())))
    }
    pub(crate) fn bytes_identity(bytes: &[u8]) -> String {
        let mut state = Fnv64State::default();
        state.update(bytes);
        state.identity()
    }
}

use super::{MediaSourceSnapshot, ProjectError};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

/// Identical byte identities for inline payloads and streamed file admission.
pub(super) struct MediaByteDigest {
    sha256: Sha256,
    left: u32,
    right: u32,
    pub length: u64,
}

impl MediaByteDigest {
    pub fn new() -> Self {
        Self {
            sha256: Sha256::new(),
            left: 0x811c9dc5,
            right: 0x9e3779b9,
            length: 0,
        }
    }

    pub fn update(&mut self, bytes: &[u8]) -> Result<(), ProjectError> {
        self.length = self
            .length
            .checked_add(bytes.len() as u64)
            .ok_or(ProjectError::InvalidMedia("media byte count overflow"))?;
        self.sha256.update(bytes);
        for byte in bytes {
            self.left = (self.left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            self.right = (self.right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        Ok(())
    }

    pub fn finish(
        self,
        bytes: Vec<u8>,
        path: Option<PathBuf>,
        byte_identity: Option<&str>,
        content_identity: Option<&str>,
    ) -> Result<MediaSourceSnapshot, ProjectError> {
        let sha256 = format!("{:x}", self.sha256.finalize());
        let identity = format!("fnv64:{:08x}{:08x}:{}", self.left, self.right, self.length);
        if byte_identity.is_some_and(|expected| expected != identity)
            || content_identity.is_some_and(|expected| {
                expected != identity && expected != format!("sha256:{sha256}")
            })
        {
            return Err(ProjectError::InvalidMedia("media content identity differs"));
        }
        Ok(MediaSourceSnapshot {
            bytes,
            byte_length: self.length,
            sha256,
            byte_identity: identity,
            path,
        })
    }
}

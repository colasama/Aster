use aster_render_project::ProjectRenderError;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};

#[derive(Clone, Serialize)]
pub(crate) struct ImageReceiptFile {
    pub path: PathBuf,
    pub sha256: String,
    pub bytes: u64,
    pub frames: u64,
}

/// Append-only frame identities remain private until the corresponding output is complete.
pub(crate) struct ImageReceiptWriter {
    path: PathBuf,
    file: Option<fs::File>,
    hash: Sha256,
    bytes: u64,
    frames: u64,
    committed: bool,
}

impl ImageReceiptWriter {
    pub fn new(path: PathBuf) -> Result<Self, ProjectRenderError> {
        let path = std::path::absolute(path)?;
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Self {
            path,
            file: Some(file),
            hash: Sha256::new(),
            bytes: 0,
            frames: 0,
            committed: false,
        })
    }

    pub fn append(
        &mut self,
        frame: &super::export_images::PngFrameReceipt,
    ) -> Result<(), ProjectRenderError> {
        let mut bytes = serde_json::to_vec(frame)?;
        bytes.push(b'\n');
        self.file
            .as_mut()
            .ok_or_else(|| ProjectRenderError::Invalid("image receipts already sealed".into()))?
            .write_all(&bytes)?;
        self.hash.update(&bytes);
        self.bytes += bytes.len() as u64;
        self.frames += 1;
        Ok(())
    }

    pub fn seal(&mut self) -> Result<(), ProjectRenderError> {
        let file = self
            .file
            .take()
            .ok_or_else(|| ProjectRenderError::Invalid("image receipts already sealed".into()))?;
        file.sync_all()?;
        Ok(())
    }

    pub fn commit(&mut self) -> ImageReceiptFile {
        self.committed = true;
        ImageReceiptFile {
            path: self.path.clone(),
            sha256: format!("{:x}", self.hash.clone().finalize()),
            bytes: self.bytes,
            frames: self.frames,
        }
    }
}

impl Drop for ImageReceiptWriter {
    fn drop(&mut self) {
        self.file.take();
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

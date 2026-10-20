use aster_render_compare::{image::RgbaImage, png::PngCodec};
use aster_render_ir::{DecodeLimits, ResourceMessage};
use aster_render_project::PreparedProjectFrame;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) struct ProjectCapture {
    temporary: PathBuf,
    destination: PathBuf,
    resources: BTreeSet<String>,
    bytes: u64,
    budget: u64,
}

#[derive(Serialize)]
pub(crate) struct FrameReceipt {
    pub index: usize,
    pub plan_sha256: String,
    pub rgba_sha256: String,
    pub png_sha256: String,
    pub width: u32,
    pub height: u32,
    pub resource_count: usize,
    pub duration_ms: u128,
    pub raster_request_sha256: Option<String>,
}

impl ProjectCapture {
    pub fn new(destination: &Path, budget: u64) -> Result<Self, Box<dyn std::error::Error>> {
        if destination.try_exists()? || budget == 0 || budget > 17_179_869_184 {
            return Err(
                "capture destination must be new and output budget must be in 1..=16 GiB".into(),
            );
        }
        let destination = std::path::absolute(destination)?;
        let parent = destination.parent().ok_or("capture parent absent")?;
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".aster-project-capture-{}.tmp", Uuid::new_v4()));
        fs::create_dir(&temporary)?;
        let pending = Self {
            temporary,
            destination,
            resources: BTreeSet::new(),
            bytes: 0,
            budget,
        };
        fs::create_dir(pending.temporary.join("resources"))?;
        Ok(pending)
    }

    pub fn write(
        &mut self,
        relative: &Path,
        bytes: &[u8],
    ) -> Result<(), Box<dyn std::error::Error>> {
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err("capture member must be a confined relative path".into());
        }
        self.bytes = self
            .bytes
            .checked_add(bytes.len() as u64)
            .filter(|n| *n <= self.budget)
            .ok_or("capture output byte budget exceeded")?;
        let path = self.temporary.join(relative);
        fs::create_dir_all(path.parent().ok_or("capture member parent absent")?)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(())
    }

    pub fn frame(
        &mut self,
        index: usize,
        prepared: &PreparedProjectFrame,
        image: &RgbaImage,
    ) -> Result<FrameReceipt, Box<dyn std::error::Error>> {
        let directory = PathBuf::from(index.to_string());
        let plan = prepared.bundle.plan.encode(&DecodeLimits::default())?;
        let png = PngCodec::encode(image)?;
        self.write(&directory.join("plan.fpln"), &plan)?;
        self.write(&directory.join("candidate.png"), &png)?;
        let mut messages = Vec::new();
        for resource in &prepared.bundle.resources {
            messages.push(ResourceMessage::PutResource(resource.request().clone()));
            let hash = resource.request().hash.0.clone();
            if self.resources.insert(hash.clone()) {
                self.write(
                    &PathBuf::from("resources").join(format!("{hash}.bin")),
                    resource.bytes(),
                )?;
            }
        }
        self.write(
            &directory.join("resources.json"),
            &serde_json::to_vec(&messages)?,
        )?;
        Ok(FrameReceipt {
            index,
            plan_sha256: format!("{:x}", Sha256::digest(plan)),
            rgba_sha256: format!("{:x}", Sha256::digest(&image.pixels)),
            png_sha256: format!("{:x}", Sha256::digest(png)),
            width: image.width,
            height: image.height,
            resource_count: messages.len(),
            duration_ms: 0,
            raster_request_sha256: None,
        })
    }

    pub fn finish(self) -> Result<(), Box<dyn std::error::Error>> {
        if self.destination.try_exists()? {
            return Err("capture destination appeared during execution".into());
        }
        fs::rename(&self.temporary, &self.destination)?;
        Ok(())
    }
}

impl Drop for ProjectCapture {
    fn drop(&mut self) {
        // This UUID directory is owned only after exclusive creation succeeds.
        let _ = fs::remove_dir_all(&self.temporary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_capture_preserves_existing_outputs_and_removes_unpublished_members()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!("aster-capture-test-{}", Uuid::new_v4()));
        fs::create_dir(&root)?;
        let destination = root.join("frames");
        {
            let mut capture = ProjectCapture::new(&destination, 3)?;
            capture.write(Path::new("0/plan.fpln"), b"abc")?;
            assert!(capture.write(Path::new("0/candidate.png"), b"x").is_err());
            assert!(!destination.try_exists()?);
        }
        assert_eq!(fs::read_dir(&root)?.count(), 0);
        let mut capture = ProjectCapture::new(&destination, 3)?;
        assert!(capture.write(Path::new("../escape"), b"x").is_err());
        capture.write(Path::new("0/plan.fpln"), b"abc")?;
        fs::create_dir(&destination)?;
        fs::write(destination.join("owner"), b"keep")?;
        assert!(capture.finish().is_err());
        assert_eq!(fs::read(destination.join("owner"))?, b"keep");
        assert!(!root.join("escape").try_exists()?);
        assert_eq!(fs::read_dir(&root)?.count(), 1);
        assert!(ProjectCapture::new(&destination, 3).is_err());
        fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn completed_capture_publishes_all_members_together() -> Result<(), Box<dyn std::error::Error>>
    {
        let root = std::env::temp_dir().join(format!("aster-capture-test-{}", Uuid::new_v4()));
        let destination = root.join("frames");
        let mut capture = ProjectCapture::new(&destination, 4)?;
        capture.write(Path::new("0/plan.fpln"), b"abc")?;
        capture.write(Path::new("report.json"), b"x")?;
        assert!(!destination.try_exists()?);
        capture.finish()?;
        assert_eq!(fs::read(destination.join("0/plan.fpln"))?, b"abc");
        assert_eq!(fs::read(destination.join("report.json"))?, b"x");
        assert_eq!(fs::read_dir(&root)?.count(), 1);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}

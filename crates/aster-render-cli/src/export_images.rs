use aster_eval::FramePlanRequest;
use aster_render_compare::{image::RgbaImage, png::PngCodec};
use aster_render_ir::Extent2d;
use aster_render_project::{ProjectExportFormat, ProjectImageOutput, ProjectRenderError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};

pub(crate) struct PngOutput {
    temporary: PathBuf,
    destination: PathBuf,
    format: ProjectExportFormat,
    size: Extent2d,
    count: u64,
    budget: u64,
    bytes: u64,
    published: bool,
    pub frames: Vec<PngFrameReceipt>,
}

#[derive(Serialize)]
pub(crate) struct PngFrameReceipt {
    index: u64,
    member: Option<String>,
    time: f64,
    time_bits: String,
    rgba_sha256: String,
    png_sha256: String,
    bytes: u64,
}

impl PngOutput {
    pub fn new(
        destination: PathBuf,
        format: ProjectExportFormat,
        size: Extent2d,
        count: u64,
        budget: u64,
    ) -> Result<Self, ProjectRenderError> {
        if format == ProjectExportFormat::Mp4
            || count == 0
            || count > 65_536
            || (format == ProjectExportFormat::Png && count != 1)
            || budget == 0
            || budget > 17_179_869_184
        {
            return Err(ProjectRenderError::Invalid(
                "invalid PNG output bounds".into(),
            ));
        }
        let destination = std::path::absolute(destination)?;
        if fs::symlink_metadata(&destination).is_ok() {
            return Err(ProjectRenderError::Invalid(
                "PNG destination already exists".into(),
            ));
        }
        let parent = destination
            .parent()
            .ok_or_else(|| ProjectRenderError::Invalid("PNG output parent absent".into()))?;
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".aster-png-{}.tmp", uuid::Uuid::new_v4()));
        fs::create_dir(&temporary)?;
        Ok(Self {
            temporary,
            destination,
            format,
            size,
            count,
            budget,
            bytes: 0,
            published: false,
            frames: Vec::new(),
        })
    }
}

impl ProjectImageOutput for PngOutput {
    fn write_frame(
        &mut self,
        index: u64,
        frame: &FramePlanRequest,
        rgba: Vec<u8>,
    ) -> Result<(), ProjectRenderError> {
        if self.published
            || index != self.frames.len() as u64
            || index >= self.count
            || frame.target != self.size
            || rgba.len() as u64 != u64::from(self.size.width) * u64::from(self.size.height) * 4
        {
            return Err(ProjectRenderError::Invalid(
                "PNG frame identity or size differs".into(),
            ));
        }
        let rgba_sha256 = format!("{:x}", Sha256::digest(&rgba));
        let image = RgbaImage {
            width: self.size.width,
            height: self.size.height,
            pixels: rgba,
        };
        let png = PngCodec::encode(&image)
            .map_err(|error| ProjectRenderError::Invalid(error.to_string()))?;
        let bytes = self
            .bytes
            .checked_add(png.len() as u64)
            .filter(|bytes| *bytes <= self.budget)
            .ok_or_else(|| ProjectRenderError::Invalid("PNG output byte budget exceeded".into()))?;
        let name = format!("frame_{index:06}.png");
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.temporary.join(&name))?;
        file.write_all(&png)?;
        file.sync_all()?;
        self.frames.push(PngFrameReceipt {
            index,
            member: (self.format == ProjectExportFormat::PngSequence).then_some(name),
            time: frame.time,
            time_bits: format!("{:016x}", frame.time.to_bits()),
            rgba_sha256,
            png_sha256: format!("{:x}", Sha256::digest(&png)),
            bytes: png.len() as u64,
        });
        self.bytes = bytes;
        Ok(())
    }

    fn finish(&mut self) -> Result<(), ProjectRenderError> {
        if self.published
            || self.frames.len() as u64 != self.count
            || fs::symlink_metadata(&self.destination).is_ok()
        {
            return Err(ProjectRenderError::Invalid(
                "PNG output incomplete or destination exists".into(),
            ));
        }
        if self.format == ProjectExportFormat::Png {
            // Exclusive publication also protects a destination created after the existence check.
            fs::hard_link(self.temporary.join("frame_000000.png"), &self.destination)?;
        } else {
            fs::rename(&self.temporary, &self.destination)?;
        }
        self.published = true;
        Ok(())
    }
}

impl Drop for PngOutput {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.temporary);
    }
}

#[cfg(test)]
mod tests;

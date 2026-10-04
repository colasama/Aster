use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Serialize;
use uuid::Uuid;

use crate::{error::CompareError, image::RgbaImage, png::PngCodec};

#[derive(Clone, Debug)]
pub struct ArtifactOptions {
    pub heatmap_gain: u16,
    pub checker_size: u32,
    pub checker_dark: u8,
    pub checker_light: u8,
    /// Combined pixels in the full-resolution heatmap and four-panel contact sheet.
    pub max_output_pixels: usize,
    pub rename: ArtifactRenameOptions,
}

#[derive(Clone, Debug)]
pub struct ArtifactRenameOptions {
    /// Includes the initial attempt; only Windows access/sharing failures are retried.
    pub max_attempts: u8,
    pub base_delay_ms: u64,
}

impl ArtifactRenameOptions {
    fn validate(&self) -> Result<(), CompareError> {
        if !(1..=5).contains(&self.max_attempts) || !(1..=50).contains(&self.base_delay_ms) {
            return Err(CompareError::InvalidArgument(
                "Artifact rename requires 1..=5 attempts and a 1..=50 ms base delay".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct ArtifactPaths {
    pub report: PathBuf,
    pub heatmap: PathBuf,
    pub contact_sheet: PathBuf,
}

pub struct ArtifactWriter;

impl ArtifactWriter {
    pub fn publish(
        output: &Path,
        reference: &RgbaImage,
        candidate: &RgbaImage,
        report: &impl Serialize,
        options: &ArtifactOptions,
    ) -> Result<ArtifactPaths, CompareError> {
        reference.validate_pair(candidate)?;
        options.rename.validate()?;
        if options.heatmap_gain == 0 || options.checker_size == 0 || options.max_output_pixels == 0
        {
            return Err(CompareError::InvalidArgument(
                "Artifact scale and budgets must be nonzero".into(),
            ));
        }
        let pixels = reference.pixels.len() / 4;
        if pixels
            .checked_mul(5)
            .is_none_or(|total| total > options.max_output_pixels)
        {
            return Err(CompareError::ResourceLimit(
                "Comparison artifact pixel budget exceeded".into(),
            ));
        }
        let sheet_width = reference
            .width
            .checked_mul(2)
            .ok_or_else(|| CompareError::ResourceLimit("Contact sheet width overflow".into()))?;
        let sheet_height = reference
            .height
            .checked_mul(2)
            .ok_or_else(|| CompareError::ResourceLimit("Contact sheet height overflow".into()))?;
        let mut heatmap = Vec::new();
        heatmap
            .try_reserve_exact(reference.pixels.len())
            .map_err(|error| {
                CompareError::ResourceLimit(format!("Heatmap allocation failed: {error}"))
            })?;
        let sheet_bytes = RgbaImage::required_bytes(sheet_width, sheet_height)?;
        let mut sheet = Vec::new();
        sheet.try_reserve_exact(sheet_bytes).map_err(|error| {
            CompareError::ResourceLimit(format!("Contact sheet allocation failed: {error}"))
        })?;
        sheet.resize(sheet_bytes, 255);
        for (index, (left, right)) in reference
            .pixels
            .chunks_exact(4)
            .zip(candidate.pixels.chunks_exact(4))
            .enumerate()
        {
            let error = left
                .iter()
                .zip(right)
                .map(|(left, right)| left.abs_diff(*right))
                .max()
                .ok_or_else(|| CompareError::InvalidImage("RGBA pixel has no channels".into()))?;
            let intensity = (u32::from(error) * u32::from(options.heatmap_gain)).min(255) as u8;
            heatmap.extend_from_slice(&[intensity, intensity, intensity, 255]);
            let x = index % reference.width as usize;
            let y = index / reference.width as usize;
            let checker = if (x / options.checker_size as usize + y / options.checker_size as usize)
                .is_multiple_of(2)
            {
                options.checker_dark
            } else {
                options.checker_light
            };
            for (column, pixel) in [left, right].iter().enumerate() {
                let position =
                    (y * sheet_width as usize + x + column * reference.width as usize) * 4;
                let backdrop = (u32::from(checker) * u32::from(255 - pixel[3]) + 127) / 255;
                // Production PNG code values already contain premultiplied sRGB.
                for channel in 0..3 {
                    sheet[position + channel] =
                        (u32::from(pixel[channel]) + backdrop).min(255) as u8;
                }
                let alpha_position = position + pixels * 8;
                sheet[alpha_position..alpha_position + 3].fill(pixel[3]);
            }
        }
        let heatmap =
            PngCodec::encode(&RgbaImage::new(reference.width, reference.height, heatmap)?)?;
        let contact_sheet = PngCodec::encode(&RgbaImage::new(sheet_width, sheet_height, sheet)?)?;
        let mut transaction = ArtifactTransaction::begin(output)?;
        transaction.write("heatmap.png", &heatmap)?;
        transaction.write("contact-sheet.png", &contact_sheet)?;
        transaction.write("report.json", &serde_json::to_vec_pretty(report)?)?;
        transaction.publish_with(
            &options.rename,
            cfg!(windows),
            |from, to| fs::rename(from, to),
            std::thread::sleep,
        )?;
        Ok(ArtifactPaths {
            report: output.join("report.json"),
            heatmap: output.join("heatmap.png"),
            contact_sheet: output.join("contact-sheet.png"),
        })
    }
}

struct ArtifactTransaction {
    output: PathBuf,
    temporary: PathBuf,
    lock: PathBuf,
    temporary_owned: bool,
}

impl ArtifactTransaction {
    fn begin(output: &Path) -> Result<Self, CompareError> {
        let name = output.file_name().ok_or_else(|| {
            CompareError::InvalidArgument("Artifact output must name a new directory".into())
        })?;
        let parent = match output.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => parent,
            _ => Path::new("."),
        };
        let metadata = fs::metadata(parent)
            .map_err(|error| CompareError::io_at("inspect artifact parent", parent, error))?;
        if !metadata.is_dir() {
            return Err(CompareError::InvalidArgument(
                "Artifact parent directory does not exist".into(),
            ));
        }
        let mut lock_name = OsString::from(".");
        lock_name.push(name);
        lock_name.push(".publish.lock");
        let lock = parent.join(lock_name);
        // Cooperating writers cannot replace or race an output owned by another invocation.
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
            .map_err(|error| CompareError::io_at("create artifact lock", &lock, error))?;
        let mut transaction = Self {
            output: output.to_path_buf(),
            temporary: parent.join(format!(".aster-compare-{}.tmp", Uuid::new_v4())),
            lock,
            temporary_owned: false,
        };
        transaction.require_absent_output()?;
        fs::create_dir(&transaction.temporary).map_err(|error| {
            CompareError::io_at("create artifact staging", &transaction.temporary, error)
        })?;
        transaction.temporary_owned = true;
        Ok(transaction)
    }

    fn require_absent_output(&self) -> Result<(), CompareError> {
        match fs::symlink_metadata(&self.output) {
            Ok(_) => Err(CompareError::InvalidArgument(format!(
                "Artifact output already exists: {}",
                self.output.display()
            ))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(CompareError::io_at(
                "inspect artifact output",
                &self.output,
                error,
            )),
        }
    }

    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), CompareError> {
        let path = self.temporary.join(name);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| CompareError::io_at("create artifact file", &path, error))?;
        file.write_all(bytes)
            .map_err(|error| CompareError::io_at("write artifact file", &path, error))?;
        file.sync_all()
            .map_err(|error| CompareError::io_at("sync artifact file", &path, error))?;
        Ok(())
    }

    fn publish_with(
        &mut self,
        options: &ArtifactRenameOptions,
        windows: bool,
        mut rename: impl FnMut(&Path, &Path) -> io::Result<()>,
        mut sleep: impl FnMut(Duration),
    ) -> Result<(), CompareError> {
        options.validate()?;
        let mut attempt = 1;
        loop {
            // Keep the complete staging directory and its publication lock across retries.
            self.require_absent_output()?;
            match rename(&self.temporary, &self.output) {
                Ok(()) => {
                    self.temporary_owned = false;
                    return Ok(());
                }
                Err(source) => {
                    if !windows
                        || !matches!(source.raw_os_error(), Some(5 | 32 | 33))
                        || attempt >= options.max_attempts
                    {
                        return Err(CompareError::ArtifactRename {
                            from: self.temporary.clone(),
                            to: self.output.clone(),
                            attempts: attempt,
                            source,
                        });
                    }
                    sleep(Duration::from_millis(
                        options.base_delay_ms * (1 << (attempt - 1)),
                    ));
                    attempt += 1;
                }
            }
        }
    }
}

impl Drop for ArtifactTransaction {
    fn drop(&mut self) {
        if self.temporary_owned {
            let _ = fs::remove_dir_all(&self.temporary);
        }
        let _ = fs::remove_file(&self.lock);
    }
}

#[cfg(test)]
#[path = "artifact_tests.rs"]
mod tests;

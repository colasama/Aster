//! Deterministic, bounded proxy-media planning and publication.
//!
//! This module intentionally does not launch FFmpeg. Callers own the process and
//! can terminate it when [`CancellationToken`] is cancelled. A successful process
//! hands its temporary output to [`ProxyGenerationPlan::finalize`] for safe publication.

use std::{
    ffi::OsString,
    fs::{self, File},
    io::{BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Debug, clap::Args)]
pub struct ProxyLimits {
    #[arg(long, default_value_t = Self::default().max_source_bytes)]
    pub max_source_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_proxy_bytes)]
    pub max_proxy_bytes: u64,
    #[arg(long, default_value_t = Self::default().max_metadata_bytes)]
    pub max_metadata_bytes: u64,
    #[arg(long, default_value_t = Self::default().hash_buffer_bytes, value_parser = clap::value_parser!(u32).range(1..))]
    pub hash_buffer_bytes: u32,
}

impl Default for ProxyLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: 2 * 1024 * 1024 * 1024,
            max_proxy_bytes: 20 * 1024 * 1024 * 1024,
            max_metadata_bytes: 64 * 1024,
            hash_buffer_bytes: 1024 * 1024,
        }
    }
}

pub struct ProxyCache {
    pub root: PathBuf,
    pub limits: ProxyLimits,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyProfile {
    pub max_width: u32,
    pub max_height: u32,
    pub video_bitrate_kbps: u32,
    pub audio_bitrate_kbps: u32,
}

impl Default for ProxyProfile {
    fn default() -> Self {
        Self {
            max_width: 1_280,
            max_height: 720,
            video_bitrate_kbps: 2_500,
            audio_bitrate_kbps: 128,
        }
    }
}

impl ProxyProfile {
    fn validate(&self) -> Result<(), ProxyError> {
        if !(16..=8_192).contains(&self.max_width)
            || !(16..=8_192).contains(&self.max_height)
            || !(64..=100_000).contains(&self.video_bitrate_kbps)
            || !(32..=512).contains(&self.audio_bitrate_kbps)
        {
            return Err(ProxyError::InvalidProfile);
        }
        Ok(())
    }

    fn fingerprint(&self) -> String {
        let value = format!(
            "{}x{}:{}:{}",
            self.max_width, self.max_height, self.video_bitrate_kbps, self.audio_bitrate_kbps
        );
        format!("{:x}", Sha256::digest(value.as_bytes()))
    }
}

/// The stable fields required to decide whether a proxy still represents its source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyMetadata {
    pub schema_version: u32,
    pub source_sha256: String,
    pub source_bytes: u64,
    pub profile: ProxyProfile,
    pub generator: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyValidity {
    Valid,
    MissingProxy,
    MissingMetadata,
    SourceChanged,
    ProfileChanged,
}

#[derive(Debug, Clone)]
pub struct ProxyGenerationPlan {
    program: PathBuf,
    arguments: Vec<OsString>,
    source: PathBuf,
    temporary_output: PathBuf,
    output: PathBuf,
    metadata_path: PathBuf,
    metadata: ProxyMetadata,
    limits: ProxyLimits,
    _artifacts: Arc<ProxyArtifacts>,
}

impl ProxyGenerationPlan {
    pub fn program(&self) -> &Path {
        &self.program
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    pub fn source(&self) -> &Path {
        &self.source
    }

    pub fn temporary_output(&self) -> &Path {
        &self.temporary_output
    }

    pub fn output(&self) -> &Path {
        &self.output
    }

    pub fn metadata_path(&self) -> &Path {
        &self.metadata_path
    }

    pub fn metadata(&self) -> &ProxyMetadata {
        &self.metadata
    }
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken(Arc<AtomicBool>);

impl CancellationToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    fn check(&self) -> Result<(), ProxyError> {
        if self.is_cancelled() {
            Err(ProxyError::Cancelled)
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("proxy profile is outside supported bounds")]
    InvalidProfile,
    #[error("proxy generation was cancelled")]
    Cancelled,
    #[error("proxy source changed during generation")]
    SourceChanged,
    #[error("proxy source must be a regular, non-symlink file: {0}")]
    UnsafeSource(PathBuf),
    #[error("proxy output must be a regular, non-symlink file: {0}")]
    UnsafeOutput(PathBuf),
    #[error("source is {0} bytes; configured limit exceeded")]
    SourceTooLarge(u64),
    #[error("proxy output is {0} bytes; outside configured bounds")]
    InvalidOutputSize(u64),
    #[error("proxy metadata is {0} bytes; configured limit exceeded")]
    MetadataTooLarge(u64),
    #[error("proxy metadata is invalid")]
    InvalidMetadata,
    #[error("metadata path has no parent")]
    MissingParent,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl ProxyCache {
    /// Captures the source and produces a process description without launching a child.
    pub fn prepare(
        &self,
        source: impl AsRef<Path>,
        ffmpeg_program: impl Into<PathBuf>,
        profile: ProxyProfile,
        cancellation: &CancellationToken,
    ) -> Result<ProxyGenerationPlan, ProxyError> {
        profile.validate()?;
        cancellation.check()?;
        let source_path = source.as_ref();
        let source_metadata = fs::symlink_metadata(source_path)?;
        if !source_metadata.is_file() || source_metadata.file_type().is_symlink() {
            return Err(ProxyError::UnsafeSource(source_path.to_owned()));
        }
        if source_metadata.len() > self.limits.max_source_bytes {
            return Err(ProxyError::SourceTooLarge(source_metadata.len()));
        }
        let source = source_path.canonicalize()?;
        fs::create_dir_all(self.root.as_path())?;
        let cache_root = self.root.as_path().canonicalize()?;
        let (snapshot, source_sha256, source_bytes) =
            self.limits
                .capture_source(&source, &cache_root, cancellation)?;
        let identity = format!("{source_sha256}-{}", &profile.fingerprint()[..16]);
        let output = cache_root.join(format!("{identity}.mp4"));
        let metadata_path = cache_root.join(format!("{identity}.proxy.json"));
        let temporary_output = cache_root.join(format!(".{identity}.{}.tmp.mp4", Uuid::new_v4()));
        let metadata = ProxyMetadata {
            schema_version: ProxyMetadata::SCHEMA_VERSION,
            source_sha256,
            source_bytes,
            profile: profile.clone(),
            generator: ProxyMetadata::GENERATOR_ID.into(),
        };
        let arguments = vec![
            "-nostdin".into(),
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-i".into(),
            snapshot.temporary.as_os_str().to_owned(),
            "-vf".into(),
            format!(
                "scale=w='min(iw,{})':h='min(ih,{})':force_original_aspect_ratio=decrease",
                profile.max_width, profile.max_height
            )
            .into(),
            "-c:v".into(),
            "libx264".into(),
            "-b:v".into(),
            format!("{}k", profile.video_bitrate_kbps).into(),
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            format!("{}k", profile.audio_bitrate_kbps).into(),
            "-movflags".into(),
            "+faststart".into(),
            "-y".into(),
            temporary_output.as_os_str().to_owned(),
        ];
        Ok(ProxyGenerationPlan {
            program: ffmpeg_program.into(),
            arguments,
            source,
            temporary_output: temporary_output.clone(),
            output,
            metadata_path,
            metadata,
            limits: self.limits.clone(),
            _artifacts: Arc::new(ProxyArtifacts {
                _snapshot: snapshot,
                temporary_output,
            }),
        })
    }
    pub fn inspect(
        &self,
        source: impl AsRef<Path>,
        proxy: impl AsRef<Path>,
        metadata_path: impl AsRef<Path>,
        expected_profile: &ProxyProfile,
        cancellation: &CancellationToken,
    ) -> Result<ProxyValidity, ProxyError> {
        let proxy_path = proxy.as_ref();
        let proxy_file = match fs::symlink_metadata(proxy_path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ProxyValidity::MissingProxy);
            }
            Err(error) => return Err(error.into()),
        };
        if !proxy_file.is_file() || proxy_file.file_type().is_symlink() {
            return Err(ProxyError::UnsafeOutput(proxy_path.to_owned()));
        }
        if proxy_file.len() == 0 || proxy_file.len() > self.limits.max_proxy_bytes {
            return Err(ProxyError::InvalidOutputSize(proxy_file.len()));
        }
        match fs::symlink_metadata(metadata_path.as_ref()) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ProxyValidity::MissingMetadata);
            }
            Err(error) => return Err(error.into()),
        }
        let metadata = ProxyMetadata::read(metadata_path.as_ref(), &self.limits)?;
        if metadata.schema_version != ProxyMetadata::SCHEMA_VERSION
            || &metadata.profile != expected_profile
        {
            return Ok(ProxyValidity::ProfileChanged);
        }
        let source_metadata = fs::metadata(source.as_ref())?;
        if source_metadata.len() != metadata.source_bytes {
            return Ok(ProxyValidity::SourceChanged);
        }
        let digest =
            self.limits
                .hash_file(source.as_ref(), cancellation, self.limits.max_source_bytes)?;
        Ok(if digest == metadata.source_sha256 {
            ProxyValidity::Valid
        } else {
            ProxyValidity::SourceChanged
        })
    }
}

impl ProxyGenerationPlan {
    /// Publishes a complete proxy only while its source still matches the captured bytes.
    pub fn finalize(&self, cancellation: &CancellationToken) -> Result<(), ProxyError> {
        cancellation.check()?;
        let metadata = fs::symlink_metadata(&self.temporary_output)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ProxyError::UnsafeOutput(self.temporary_output.clone()));
        }
        if metadata.len() == 0 || metadata.len() > self.limits.max_proxy_bytes {
            return Err(ProxyError::InvalidOutputSize(metadata.len()));
        }
        if self
            .limits
            .hash_file(&self.source, cancellation, self.limits.max_source_bytes)?
            != self.metadata.source_sha256
        {
            return Err(ProxyError::SourceChanged);
        }
        cancellation.check()?;
        File::options()
            .write(true)
            .open(&self.temporary_output)?
            .sync_all()?;
        fs::rename(&self.temporary_output, &self.output)?;
        self.metadata.write(&self.metadata_path, &self.limits)
    }
}

impl ProxyMetadata {
    const SCHEMA_VERSION: u32 = 1;
    const GENERATOR_ID: &str = "aster-ffmpeg-proxy-v1";
    pub fn write(&self, path: impl AsRef<Path>, limits: &ProxyLimits) -> Result<(), ProxyError> {
        self.validate(limits)?;
        let path = path.as_ref();
        let parent = path.parent().ok_or(ProxyError::MissingParent)?;
        fs::create_dir_all(parent)?;
        crate::AtomicFile::write(path, |file| {
            let mut writer = BufWriter::new(file);
            serde_json::to_writer_pretty(&mut writer, self)?;
            writer.write_all(b"\n")?;
            writer.flush()?;
            Ok(())
        })
    }
    pub fn read(path: &Path, limits: &ProxyLimits) -> Result<ProxyMetadata, ProxyError> {
        let metadata = fs::symlink_metadata(path)?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(ProxyError::InvalidMetadata);
        }
        if metadata.len() > limits.max_metadata_bytes {
            return Err(ProxyError::MetadataTooLarge(metadata.len()));
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        File::open(path)?
            .take(limits.max_metadata_bytes.saturating_add(1))
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > limits.max_metadata_bytes {
            return Err(ProxyError::MetadataTooLarge(bytes.len() as u64));
        }
        let metadata: ProxyMetadata = serde_json::from_slice(&bytes)?;
        metadata.validate(limits)?;
        Ok(metadata)
    }
    fn validate(&self, limits: &ProxyLimits) -> Result<(), ProxyError> {
        self.profile.validate()?;
        if self.schema_version != Self::SCHEMA_VERSION
            || self.source_bytes > limits.max_source_bytes
            || self.source_sha256.len() != 64
            || !self
                .source_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            || self.generator != Self::GENERATOR_ID
        {
            return Err(ProxyError::InvalidMetadata);
        }
        Ok(())
    }
}

impl ProxyLimits {
    fn hash_file(
        &self,
        path: &Path,
        cancellation: &CancellationToken,
        maximum_bytes: u64,
    ) -> Result<String, ProxyError> {
        let mut reader =
            BufReader::with_capacity(self.hash_buffer_bytes.max(1) as usize, File::open(path)?);
        let mut buffer = vec![0_u8; self.hash_buffer_bytes.max(1) as usize];
        let mut digest = Sha256::new();
        let mut total = 0_u64;
        loop {
            cancellation.check()?;
            let read = reader.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            total = total.saturating_add(read as u64);
            if total > maximum_bytes {
                return Err(ProxyError::SourceTooLarge(total));
            }
            digest.update(&buffer[..read]);
        }
        Ok(format!("{:x}", digest.finalize()))
    }
    fn capture_source(
        &self,
        source: &Path,
        cache: &Path,
        cancellation: &CancellationToken,
    ) -> Result<(crate::AtomicFile, String, u64), ProxyError> {
        let (snapshot, mut output) = crate::AtomicFile::stage(&cache.join("source"))?;
        let mut input = File::open(source)?;
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; self.hash_buffer_bytes.max(1) as usize];
        let mut total = 0_u64;
        loop {
            cancellation.check()?;
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            total = total.saturating_add(count as u64);
            if total > self.max_source_bytes {
                return Err(ProxyError::SourceTooLarge(total));
            }
            output.write_all(&buffer[..count])?;
            digest.update(&buffer[..count]);
        }
        output.sync_all()?;
        Ok((snapshot, format!("{:x}", digest.finalize()), total))
    }
}

#[derive(Debug)]
struct ProxyArtifacts {
    _snapshot: crate::AtomicFile,
    temporary_output: PathBuf,
}

impl Drop for ProxyArtifacts {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.temporary_output);
    }
}

#[cfg(test)]
mod tests;

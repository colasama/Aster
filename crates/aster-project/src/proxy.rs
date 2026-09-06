//! Deterministic, bounded proxy-media planning and publication.
//!
//! This module intentionally does not launch FFmpeg. Callers own the process and
//! can terminate it when [`CancellationToken`] is cancelled. A successful process
//! hands its temporary output to [`finalize_proxy_generation`] for safe publication.

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

const PROXY_SCHEMA_VERSION: u32 = 1;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PROXY_BYTES: u64 = 20 * 1024 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const GENERATOR_ID: &str = "aster-ffmpeg-proxy-v1";

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
        hex_digest(Sha256::digest(value.as_bytes()))
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

/// Hashes the source and produces a process description. It never launches a child process.
pub fn prepare_proxy_generation(
    source: impl AsRef<Path>,
    cache_root: impl AsRef<Path>,
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
    if source_metadata.len() > MAX_SOURCE_BYTES {
        return Err(ProxyError::SourceTooLarge(source_metadata.len()));
    }
    let source = source_path.canonicalize()?;
    fs::create_dir_all(cache_root.as_ref())?;
    let cache_root = cache_root.as_ref().canonicalize()?;
    let source_sha256 = hash_file(&source, cancellation, MAX_SOURCE_BYTES)?;
    let identity = format!("{source_sha256}-{}", &profile.fingerprint()[..16]);
    let output = cache_root.join(format!("{identity}.mp4"));
    let metadata_path = cache_root.join(format!("{identity}.proxy.json"));
    let temporary_output = cache_root.join(format!(".{identity}.{}.tmp.mp4", Uuid::new_v4()));
    let metadata = ProxyMetadata {
        schema_version: PROXY_SCHEMA_VERSION,
        source_sha256,
        source_bytes: source_metadata.len(),
        profile: profile.clone(),
        generator: GENERATOR_ID.into(),
    };
    let arguments = vec![
        "-nostdin".into(),
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-i".into(),
        source.as_os_str().to_owned(),
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
        temporary_output,
        output,
        metadata_path,
        metadata,
    })
}

/// Publishes only a bounded regular file produced at the exact planned path.
pub fn finalize_proxy_generation(
    plan: &ProxyGenerationPlan,
    cancellation: &CancellationToken,
) -> Result<(), ProxyError> {
    cancellation.check()?;
    let metadata = fs::symlink_metadata(&plan.temporary_output)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProxyError::UnsafeOutput(plan.temporary_output.clone()));
    }
    if metadata.len() == 0 || metadata.len() > MAX_PROXY_BYTES {
        return Err(ProxyError::InvalidOutputSize(metadata.len()));
    }
    File::options()
        .write(true)
        .open(&plan.temporary_output)?
        .sync_all()?;
    fs::rename(&plan.temporary_output, &plan.output)?;
    write_proxy_metadata(&plan.metadata_path, &plan.metadata)
}

pub fn write_proxy_metadata(
    path: impl AsRef<Path>,
    metadata: &ProxyMetadata,
) -> Result<(), ProxyError> {
    validate_metadata(metadata)?;
    let path = path.as_ref();
    let parent = path.parent().ok_or(ProxyError::MissingParent)?;
    fs::create_dir_all(parent)?;
    crate::AtomicFile::write(path, |file| {
        let mut writer = BufWriter::new(file);
        serde_json::to_writer_pretty(&mut writer, metadata)?;
        writer.write_all(b"\n")?;
        writer.flush()?;
        Ok(())
    })
}

pub fn inspect_proxy(
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
    if proxy_file.len() == 0 || proxy_file.len() > MAX_PROXY_BYTES {
        return Err(ProxyError::InvalidOutputSize(proxy_file.len()));
    }
    match fs::symlink_metadata(metadata_path.as_ref()) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ProxyValidity::MissingMetadata);
        }
        Err(error) => return Err(error.into()),
    }
    let metadata = read_proxy_metadata(metadata_path.as_ref())?;
    if metadata.schema_version != PROXY_SCHEMA_VERSION || &metadata.profile != expected_profile {
        return Ok(ProxyValidity::ProfileChanged);
    }
    let source_metadata = fs::metadata(source.as_ref())?;
    if source_metadata.len() != metadata.source_bytes {
        return Ok(ProxyValidity::SourceChanged);
    }
    let digest = hash_file(source.as_ref(), cancellation, MAX_SOURCE_BYTES)?;
    Ok(if digest == metadata.source_sha256 {
        ProxyValidity::Valid
    } else {
        ProxyValidity::SourceChanged
    })
}

fn read_proxy_metadata(path: &Path) -> Result<ProxyMetadata, ProxyError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProxyError::InvalidMetadata);
    }
    if metadata.len() > MAX_METADATA_BYTES {
        return Err(ProxyError::MetadataTooLarge(metadata.len()));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)?
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err(ProxyError::MetadataTooLarge(bytes.len() as u64));
    }
    let metadata: ProxyMetadata = serde_json::from_slice(&bytes)?;
    validate_metadata(&metadata)?;
    Ok(metadata)
}

fn validate_metadata(metadata: &ProxyMetadata) -> Result<(), ProxyError> {
    metadata.profile.validate()?;
    if metadata.schema_version != PROXY_SCHEMA_VERSION
        || metadata.source_bytes > MAX_SOURCE_BYTES
        || metadata.source_sha256.len() != 64
        || !metadata
            .source_sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || metadata.generator != GENERATOR_ID
    {
        return Err(ProxyError::InvalidMetadata);
    }
    Ok(())
}

fn hash_file(
    path: &Path,
    cancellation: &CancellationToken,
    maximum_bytes: u64,
) -> Result<String, ProxyError> {
    let mut reader = BufReader::with_capacity(HASH_BUFFER_BYTES, File::open(path)?);
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
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
    Ok(hex_digest(digest.finalize()))
}

fn hex_digest(bytes: impl AsRef<[u8]>) -> String {
    bytes
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("proxy profile is outside supported MVP bounds")]
    InvalidProfile,
    #[error("proxy generation was cancelled")]
    Cancelled,
    #[error("proxy source must be a regular, non-symlink file: {0}")]
    UnsafeSource(PathBuf),
    #[error("proxy output must be a regular, non-symlink file: {0}")]
    UnsafeOutput(PathBuf),
    #[error("source is {0} bytes; maximum is 2147483648")]
    SourceTooLarge(u64),
    #[error("proxy output is {0} bytes; expected 1..=21474836480")]
    InvalidOutputSize(u64),
    #[error("proxy metadata is {0} bytes; maximum is 65536")]
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

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("aster-proxy-test-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> (TestDir, PathBuf) {
        let root = TestDir::new();
        let source = root.path().join("source.mov");
        fs::write(&source, b"stable source bytes").unwrap();
        (root, source)
    }

    #[test]
    fn plan_identity_is_content_and_profile_addressed() {
        let (root, source) = fixture();
        let cache = root.path().join("cache");
        let token = CancellationToken::default();
        let first =
            prepare_proxy_generation(&source, &cache, "ffmpeg", ProxyProfile::default(), &token)
                .unwrap();
        let second =
            prepare_proxy_generation(&source, &cache, "ffmpeg", ProxyProfile::default(), &token)
                .unwrap();
        assert_eq!(first.output(), second.output());
        assert_eq!(first.metadata(), second.metadata());
        assert_ne!(first.temporary_output(), second.temporary_output());
        assert_eq!(
            first.arguments().last().map(OsString::as_os_str),
            Some(first.temporary_output().as_os_str())
        );
    }

    #[test]
    fn finalization_and_source_invalidation_are_safe() {
        let (root, source) = fixture();
        let token = CancellationToken::default();
        let plan = prepare_proxy_generation(
            &source,
            root.path().join("cache"),
            "ffmpeg",
            ProxyProfile::default(),
            &token,
        )
        .unwrap();
        fs::write(plan.temporary_output(), b"proxy").unwrap();
        finalize_proxy_generation(&plan, &token).unwrap();
        assert_eq!(
            inspect_proxy(
                &source,
                plan.output(),
                plan.metadata_path(),
                &plan.metadata().profile,
                &token
            )
            .unwrap(),
            ProxyValidity::Valid
        );
        // Same byte length proves invalidation is content-based rather than a size shortcut.
        fs::write(&source, b"mutable source byte").unwrap();
        assert_eq!(
            inspect_proxy(
                &source,
                plan.output(),
                plan.metadata_path(),
                &plan.metadata().profile,
                &token
            )
            .unwrap(),
            ProxyValidity::SourceChanged
        );
    }

    #[test]
    fn cancellation_prevents_planning_and_publication() {
        let (root, source) = fixture();
        let token = CancellationToken::default();
        token.cancel();
        assert!(matches!(
            prepare_proxy_generation(
                source,
                root.path().join("cache"),
                "ffmpeg",
                ProxyProfile::default(),
                &token
            ),
            Err(ProxyError::Cancelled)
        ));
    }

    #[test]
    fn rejects_oversized_metadata_before_json_parsing() {
        let (root, source) = fixture();
        let proxy = root.path().join("proxy.mp4");
        let metadata = root.path().join("proxy.json");
        fs::write(&proxy, b"proxy").unwrap();
        fs::write(&metadata, vec![b' '; MAX_METADATA_BYTES as usize + 1]).unwrap();
        assert!(matches!(
            inspect_proxy(
                source,
                proxy,
                metadata,
                &ProxyProfile::default(),
                &CancellationToken::default(),
            ),
            Err(ProxyError::MetadataTooLarge(_))
        ));
    }
}

use super::{GrantedSource, MediaGrants};
use crate::MediaError;
use aster_render_ir::ResourceHash;
use aster_video::CancellationToken;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Cursor, Read, Write},
    sync::Arc,
};

pub(crate) struct VideoSourceIdentity {
    pub bytes: u64,
    pub sha256: String,
}

impl MediaGrants {
    /// The destination must stay private until this complete authenticated copy succeeds.
    pub(crate) fn copy_video_to(
        &self,
        source: &ResourceHash,
        scope: &str,
        identity: &str,
        maximum: u64,
        cancellation: &CancellationToken,
        output: &mut dyn Write,
    ) -> Result<VideoSourceIdentity, MediaError> {
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if maximum == 0 || maximum == u64::MAX {
            return Err(MediaError::Limit(
                "positive bounded source limit required".into(),
            ));
        }
        let grant = self
            .grants
            .get(&(source.clone(), None))
            .filter(|grant| match grant {
                GrantedSource::File(grant) => grant.scope == scope,
                GrantedSource::Snapshot(grant) => grant.scope == scope,
            })
            .ok_or_else(|| MediaError::Authorization("source or scope is not granted".into()))?;
        let (mut input, expected): (Box<dyn Read>, &str) = match grant {
            GrantedSource::File(grant) => {
                let file = File::open(&grant.path)?;
                let metadata = file.metadata()?;
                if !metadata.is_file() || metadata.len() > maximum {
                    return Err(MediaError::Limit("source exceeds file byte budget".into()));
                }
                (Box::new(file), &grant.sha256)
            }
            GrantedSource::Snapshot(grant) => {
                if grant.bytes.len() as u64 > maximum {
                    return Err(MediaError::Limit(
                        "snapshot exceeds source byte budget".into(),
                    ));
                }
                (
                    Box::new(Cursor::new(Arc::clone(&grant.bytes))),
                    &grant.sha256,
                )
            }
        };
        let mut buffer = [0_u8; 65536];
        let mut digest = Sha256::new();
        let (mut left, mut right, mut length) = (0x811c9dc5_u32, 0x9e3779b9_u32, 0_u64);
        let portable = identity != format!("sha256:{expected}");
        loop {
            if cancellation.is_cancelled() {
                return Err(aster_video::FfmpegError::Cancelled.into());
            }
            let read = input.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            length = length
                .checked_add(read as u64)
                .filter(|n| *n <= maximum)
                .ok_or_else(|| {
                    MediaError::Limit("source changed beyond file byte budget".into())
                })?;
            let bytes = &buffer[..read];
            digest.update(bytes);
            if portable {
                for byte in bytes {
                    left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
                    right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
                }
            }
            output.write_all(bytes)?;
        }
        let sha256 = format!("{:x}", digest.finalize());
        if sha256 != expected
            || (portable && identity != format!("fnv64:{left:08x}{right:08x}:{length}"))
        {
            return Err(MediaError::Identity);
        }
        Ok(VideoSourceIdentity {
            bytes: length,
            sha256,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{MediaSnapshotAuthorization, SnapshotGrantLimits, StillAuthorization};
    use std::{io, path::PathBuf};

    struct Fixture {
        root: PathBuf,
        source: ResourceHash,
        bytes: Vec<u8>,
        sha256: String,
    }

    impl Fixture {
        fn new() -> Result<Self, io::Error> {
            let root =
                std::env::temp_dir().join(format!("aster-video-grant-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root)?;
            let bytes: Vec<u8> = (0..(65536 * 3 + 7)).map(|i| (i % 251) as u8).collect();
            std::fs::write(root.join("source.bin"), &bytes)?;
            Ok(Self {
                root,
                source: ResourceHash("1".repeat(64)),
                sha256: format!("{:x}", Sha256::digest(&bytes)),
                bytes,
            })
        }

        fn grants(&self, inline: bool) -> Result<MediaGrants, MediaError> {
            if inline {
                MediaGrants::with_snapshots(
                    Vec::new(),
                    vec![MediaSnapshotAuthorization {
                        source: self.source.clone(),
                        sequence_frame: None,
                        scope: "video".into(),
                        bytes: self.bytes.clone().into(),
                        sha256: self.sha256.clone(),
                    }],
                    SnapshotGrantLimits::default(),
                )
            } else {
                MediaGrants::new(vec![StillAuthorization {
                    source: self.source.clone(),
                    sequence_frame: None,
                    scope: "video".into(),
                    path: self.root.join("source.bin"),
                    sha256: self.sha256.clone(),
                }])
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    struct ChunkWriter {
        bytes: Vec<u8>,
        maximum_chunk: usize,
        cancel: Option<CancellationToken>,
        fail: bool,
    }

    impl Write for ChunkWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.fail {
                return Err(io::Error::other("destination unavailable"));
            }
            self.maximum_chunk = self.maximum_chunk.max(bytes.len());
            self.bytes.extend_from_slice(bytes);
            if let Some(cancel) = &self.cancel {
                cancel.cancel();
            }
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn streamed_video_grants_preserve_bytes_identity_and_bounded_writes()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = Fixture::new()?;
        let maximum = fixture.bytes.len() as u64;
        for inline in [false, true] {
            let grants = fixture.grants(inline)?;
            let retained = grants.read(
                &fixture.source,
                "video",
                None,
                &format!("sha256:{}", fixture.sha256),
                maximum,
                &CancellationToken::default(),
            )?;
            let (mut left, mut right) = (0x811c9dc5_u32, 0x9e3779b9_u32);
            for byte in &retained.bytes {
                left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
                right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
            }
            for identity in [
                format!("sha256:{}", retained.sha256),
                format!("fnv64:{left:08x}{right:08x}:{maximum}"),
            ] {
                let mut writer = ChunkWriter {
                    bytes: Vec::new(),
                    maximum_chunk: 0,
                    cancel: None,
                    fail: false,
                };
                let receipt = grants.copy_video_to(
                    &fixture.source,
                    "video",
                    &identity,
                    maximum,
                    &CancellationToken::default(),
                    &mut writer,
                )?;
                assert_eq!(receipt.sha256, retained.sha256);
                assert_eq!(receipt.bytes, maximum);
                assert_eq!(writer.bytes, retained.bytes);
                assert_eq!(writer.maximum_chunk, 65536);
            }
            let mut destination = Vec::new();
            assert!(
                grants
                    .copy_video_to(
                        &fixture.source,
                        "other",
                        &fixture.sha256,
                        maximum,
                        &CancellationToken::default(),
                        &mut destination
                    )
                    .is_err()
            );
            assert!(destination.is_empty());
            assert!(
                grants
                    .copy_video_to(
                        &fixture.source,
                        "video",
                        &fixture.sha256,
                        maximum - 1,
                        &CancellationToken::default(),
                        &mut destination
                    )
                    .is_err()
            );
            assert!(destination.is_empty());
            assert!(matches!(
                grants.copy_video_to(
                    &fixture.source,
                    "video",
                    "sha256:wrong",
                    maximum,
                    &CancellationToken::default(),
                    &mut destination
                ),
                Err(MediaError::Identity)
            ));
        }
        let grants = fixture.grants(false)?;
        std::fs::write(
            fixture.root.join("source.bin"),
            vec![0; fixture.bytes.len()],
        )?;
        assert!(matches!(
            grants.copy_video_to(
                &fixture.source,
                "video",
                &format!("sha256:{}", fixture.sha256),
                maximum,
                &CancellationToken::default(),
                &mut io::sink()
            ),
            Err(MediaError::Identity)
        ));
        Ok(())
    }

    #[test]
    fn streamed_video_grants_stop_on_cancellation_and_destination_failure()
    -> Result<(), Box<dyn std::error::Error>> {
        let fixture = Fixture::new()?;
        let grants = fixture.grants(false)?;
        let cancellation = CancellationToken::default();
        let mut writer = ChunkWriter {
            bytes: Vec::new(),
            maximum_chunk: 0,
            cancel: Some(cancellation.clone()),
            fail: false,
        };
        assert!(matches!(
            grants.copy_video_to(
                &fixture.source,
                "video",
                &format!("sha256:{}", fixture.sha256),
                fixture.bytes.len() as u64,
                &cancellation,
                &mut writer
            ),
            Err(MediaError::Decode(aster_video::FfmpegError::Cancelled))
        ));
        assert_eq!(writer.bytes.len(), 65536);
        writer.cancel = None;
        writer.fail = true;
        writer.bytes.clear();
        assert!(matches!(
            grants.copy_video_to(
                &fixture.source,
                "video",
                &format!("sha256:{}", fixture.sha256),
                fixture.bytes.len() as u64,
                &CancellationToken::default(),
                &mut writer
            ),
            Err(MediaError::Io(_))
        ));
        assert!(writer.bytes.is_empty());
        Ok(())
    }
}

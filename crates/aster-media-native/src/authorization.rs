use std::{collections::BTreeMap, fs::File, io::Read, path::PathBuf, sync::Arc};

use aster_render_ir::ResourceHash;
use aster_video::CancellationToken;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::MediaError;

/// A job broker grants paths explicitly; frame descriptors never grant file access.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StillAuthorization {
    pub source: ResourceHash,
    /// Sequence grants authorize one member, never an inferred neighboring path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sequence_frame: Option<i64>,
    pub scope: String,
    pub path: PathBuf,
    pub sha256: String,
}

/// A broker supplies immutable portable bytes instead of materializing a temporary file.
#[derive(Clone)]
pub struct MediaSnapshotAuthorization {
    pub source: ResourceHash,
    pub sequence_frame: Option<i64>,
    pub scope: String,
    pub bytes: Arc<[u8]>,
    pub sha256: String,
}

#[derive(Clone, Debug, clap::Args)]
pub struct SnapshotGrantLimits {
    #[arg(long, default_value_t = Self::default().snapshot_grant_bytes)]
    pub snapshot_grant_bytes: u64,
    #[arg(long, default_value_t = Self::default().snapshot_grant_entries)]
    pub snapshot_grant_entries: usize,
}

impl Default for SnapshotGrantLimits {
    fn default() -> Self {
        Self {
            snapshot_grant_bytes: 134_217_728,
            snapshot_grant_entries: 50_000,
        }
    }
}

enum GrantedSource {
    File(StillAuthorization),
    Snapshot(MediaSnapshotAuthorization),
}

pub(crate) struct SourceSnapshot {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub(crate) struct MediaGrants {
    grants: BTreeMap<(ResourceHash, Option<i64>), GrantedSource>,
}

impl MediaGrants {
    pub(crate) fn new(authorizations: Vec<StillAuthorization>) -> Result<Self, MediaError> {
        let mut grants = BTreeMap::new();
        for grant in authorizations {
            grant.source.validate()?;
            ResourceHash(grant.sha256.clone()).validate()?;
            if grant.scope.is_empty()
                || !grant.path.is_absolute()
                || grants
                    .insert(
                        (grant.source.clone(), grant.sequence_frame),
                        GrantedSource::File(grant),
                    )
                    .is_some()
            {
                return Err(MediaError::Authorization(
                    "unique source members, absolute paths and nonempty scopes required".into(),
                ));
            }
        }
        Ok(Self { grants })
    }

    pub(crate) fn with_snapshots(
        authorizations: Vec<StillAuthorization>,
        snapshots: Vec<MediaSnapshotAuthorization>,
        limits: SnapshotGrantLimits,
    ) -> Result<Self, MediaError> {
        if limits.snapshot_grant_bytes == 0
            || limits.snapshot_grant_bytes == u64::MAX
            || limits.snapshot_grant_entries == 0
            || snapshots.len() > limits.snapshot_grant_entries
        {
            return Err(MediaError::Limit("bounded snapshot grants required".into()));
        }
        let mut grants = Self::new(authorizations)?;
        let mut resident = 0_u64;
        for grant in snapshots {
            grant.source.validate()?;
            ResourceHash(grant.sha256.clone()).validate()?;
            resident = resident
                .checked_add(grant.bytes.len() as u64)
                .ok_or_else(|| MediaError::Limit("snapshot byte budget overflow".into()))?;
            if resident > limits.snapshot_grant_bytes {
                return Err(MediaError::Limit("snapshot byte budget exceeded".into()));
            }
            if grant.scope.is_empty()
                || grants
                    .grants
                    .contains_key(&(grant.source.clone(), grant.sequence_frame))
            {
                return Err(MediaError::Authorization(
                    "unique source members and nonempty snapshot scopes required".into(),
                ));
            }
            if format!("{:x}", Sha256::digest(&grant.bytes)) != grant.sha256 {
                return Err(MediaError::Identity);
            }
            grants.grants.insert(
                (grant.source.clone(), grant.sequence_frame),
                GrantedSource::Snapshot(grant),
            );
        }
        Ok(grants)
    }

    pub(crate) fn read(
        &self,
        source: &ResourceHash,
        scope: &str,
        member: Option<i64>,
        identity: &str,
        max_bytes: u64,
        cancellation: &CancellationToken,
    ) -> Result<SourceSnapshot, MediaError> {
        let grant = self
            .grants
            .get(&(source.clone(), member))
            .filter(|grant| match grant {
                GrantedSource::File(grant) => grant.scope == scope,
                GrantedSource::Snapshot(grant) => grant.scope == scope,
            })
            .ok_or_else(|| MediaError::Authorization("source or scope is not granted".into()))?;
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if max_bytes == 0 || max_bytes == u64::MAX {
            return Err(MediaError::Limit(
                "positive bounded source limit required".into(),
            ));
        }
        let (bytes, sha256) = match grant {
            GrantedSource::File(grant) => {
                let file = File::open(&grant.path)?;
                let metadata = file.metadata()?;
                if !metadata.is_file() || metadata.len() > max_bytes {
                    return Err(MediaError::Limit("source exceeds file byte budget".into()));
                }
                let mut bytes = Vec::new();
                file.take(max_bytes + 1).read_to_end(&mut bytes)?;
                if bytes.len() as u64 > max_bytes {
                    return Err(MediaError::Limit(
                        "source changed beyond file byte budget".into(),
                    ));
                }
                let sha256 = format!("{:x}", Sha256::digest(&bytes));
                if sha256 != grant.sha256 {
                    return Err(MediaError::Identity);
                }
                (bytes, sha256)
            }
            GrantedSource::Snapshot(grant) => {
                if grant.bytes.len() as u64 > max_bytes {
                    return Err(MediaError::Limit(
                        "snapshot exceeds source byte budget".into(),
                    ));
                }
                (grant.bytes.to_vec(), grant.sha256.clone())
            }
        };
        // Files are authenticated on every read; immutable snapshots were checked at admission.
        // Legacy identity compatibility still checks the bytes against the descriptor.
        if identity != format!("sha256:{sha256}") {
            let (mut left, mut right) = (0x811c9dc5_u32, 0x9e3779b9_u32);
            for byte in &bytes {
                left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
                right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
            }
            if identity != format!("fnv64:{left:08x}{right:08x}:{}", bytes.len()) {
                return Err(MediaError::Identity);
            }
        }
        Ok(SourceSnapshot { bytes, sha256 })
    }
}

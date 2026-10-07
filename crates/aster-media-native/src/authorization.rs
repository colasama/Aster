use std::{collections::BTreeMap, fs::File, io::Read, path::PathBuf};

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

pub(crate) struct SourceSnapshot {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub(crate) struct MediaGrants {
    grants: BTreeMap<(ResourceHash, Option<i64>), StillAuthorization>,
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
                    .insert((grant.source.clone(), grant.sequence_frame), grant)
                    .is_some()
            {
                return Err(MediaError::Authorization(
                    "unique source members, absolute paths and nonempty scopes required".into(),
                ));
            }
        }
        Ok(Self { grants })
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
            .filter(|grant| grant.scope == scope)
            .ok_or_else(|| MediaError::Authorization("source or scope is not granted".into()))?;
        if cancellation.is_cancelled() {
            return Err(aster_video::FfmpegError::Cancelled.into());
        }
        if max_bytes == 0 || max_bytes == u64::MAX {
            return Err(MediaError::Limit(
                "positive bounded source limit required".into(),
            ));
        }
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
        let (mut left, mut right) = (0x811c9dc5_u32, 0x9e3779b9_u32);
        for byte in &bytes {
            left = (left ^ u32::from(*byte)).wrapping_mul(0x01000193);
            right = (right ^ u32::from(*byte)).wrapping_mul(0x85ebca6b);
        }
        if sha256 != grant.sha256
            || identity != format!("fnv64:{left:08x}{right:08x}:{}", bytes.len())
        {
            return Err(MediaError::Identity);
        }
        Ok(SourceSnapshot { bytes, sha256 })
    }
}

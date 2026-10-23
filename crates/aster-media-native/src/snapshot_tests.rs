use crate::{
    MediaError, MediaSnapshotAuthorization, SnapshotGrantLimits, StillAuthorization,
    authorization::MediaGrants,
};
use aster_render_ir::ResourceHash;
use aster_video::{CancellationToken, FfmpegError};
use sha2::{Digest, Sha256};
use std::sync::Arc;

struct Fixture;

impl Fixture {
    fn grant() -> MediaSnapshotAuthorization {
        let bytes: Arc<[u8]> = Arc::from(&b"identity-fixture"[..]);
        MediaSnapshotAuthorization {
            source: ResourceHash("a".repeat(64)),
            sequence_frame: Some(7),
            scope: "portable-job".into(),
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes,
        }
    }

    fn limits(bytes: u64, entries: usize) -> SnapshotGrantLimits {
        SnapshotGrantLimits {
            snapshot_grant_bytes: bytes,
            snapshot_grant_entries: entries,
        }
    }
}

#[test]
fn snapshots_preserve_scope_member_identity_and_cancellation() -> Result<(), MediaError> {
    let grant = Fixture::grant();
    let grants = MediaGrants::with_snapshots(vec![], vec![grant.clone()], Fixture::limits(16, 1))?;
    let token = CancellationToken::default();
    let identity = format!("sha256:{}", grant.sha256);
    let read = |scope: &str, member, identity: &str, limit| {
        grants.read(&grant.source, scope, member, identity, limit, &token)
    };
    assert_eq!(
        read(&grant.scope, Some(7), &identity, 16)?.bytes,
        grant.bytes.as_ref()
    );
    assert_eq!(
        read(&grant.scope, Some(7), "fnv64:5ec517ef189ba6b3:16", 16)?.bytes,
        grant.bytes.as_ref()
    );
    for (scope, member) in [
        ("wrong", Some(7)),
        (grant.scope.as_str(), Some(8)),
        (grant.scope.as_str(), None),
    ] {
        assert!(matches!(
            read(scope, member, &identity, 16),
            Err(MediaError::Authorization(_))
        ));
    }
    assert!(matches!(
        read(&grant.scope, Some(7), "fnv64:0000000000000000:16", 16),
        Err(MediaError::Identity)
    ));
    assert!(matches!(
        read(&grant.scope, Some(7), &identity, 15),
        Err(MediaError::Limit(_))
    ));
    token.cancel();
    assert!(matches!(
        read(&grant.scope, Some(7), &identity, 16),
        Err(MediaError::Decode(FfmpegError::Cancelled))
    ));
    Ok(())
}

#[test]
fn snapshot_admission_rejects_corruption_duplicates_and_aggregate_expansion() {
    let grant = Fixture::grant();
    let mut corrupt = grant.clone();
    corrupt.sha256 = "0".repeat(64);
    assert!(matches!(
        MediaGrants::with_snapshots(vec![], vec![corrupt], Fixture::limits(16, 1)),
        Err(MediaError::Identity)
    ));
    let mut other = grant.clone();
    other.sequence_frame = Some(8);
    assert!(matches!(
        MediaGrants::with_snapshots(
            vec![],
            vec![grant.clone(), other.clone()],
            Fixture::limits(31, 2)
        ),
        Err(MediaError::Limit(_))
    ));
    assert!(matches!(
        MediaGrants::with_snapshots(vec![], vec![grant.clone(), other], Fixture::limits(32, 1)),
        Err(MediaError::Limit(_))
    ));
    assert!(matches!(
        MediaGrants::with_snapshots(
            vec![],
            vec![grant.clone(), grant.clone()],
            Fixture::limits(32, 2)
        ),
        Err(MediaError::Authorization(_))
    ));
    let file = StillAuthorization {
        source: grant.source.clone(),
        sequence_frame: grant.sequence_frame,
        scope: grant.scope.clone(),
        path: std::env::temp_dir().join("not-opened-snapshot-conflict"),
        sha256: grant.sha256.clone(),
    };
    assert!(matches!(
        MediaGrants::with_snapshots(vec![file], vec![grant], Fixture::limits(16, 1)),
        Err(MediaError::Authorization(_))
    ));
}

#[test]
fn incremental_snapshot_grants_preserve_aggregate_limits_and_existing_members()
-> Result<(), MediaError> {
    let first = Fixture::grant();
    let mut second = first.clone();
    second.sequence_frame = Some(8);
    let addition =
        MediaGrants::with_snapshots(vec![], vec![second.clone()], Fixture::limits(32, 2))?;
    for limits in [Fixture::limits(31, 2), Fixture::limits(32, 1)] {
        let grants = MediaGrants::with_snapshots(vec![], vec![first.clone()], limits)?;
        assert!(matches!(
            grants.check_extension(&addition),
            Err(MediaError::Limit(_))
        ));
        assert!(
            grants
                .read(
                    &second.source,
                    &second.scope,
                    second.sequence_frame,
                    &format!("sha256:{}", second.sha256),
                    16,
                    &CancellationToken::default()
                )
                .is_err()
        );
    }
    let mut grants =
        MediaGrants::with_snapshots(vec![], vec![first.clone()], Fixture::limits(48, 3))?;
    grants.check_extension(&addition)?;
    grants.append_checked(addition.clone());
    assert!(matches!(
        grants.check_extension(&addition),
        Err(MediaError::Authorization(_))
    ));
    for grant in [first, second] {
        assert_eq!(
            grants
                .read(
                    &grant.source,
                    &grant.scope,
                    grant.sequence_frame,
                    &format!("sha256:{}", grant.sha256),
                    16,
                    &CancellationToken::default()
                )?
                .bytes,
            grant.bytes.as_ref()
        );
    }
    Ok(())
}

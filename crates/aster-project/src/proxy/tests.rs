use super::*;

struct TestDir(PathBuf);

impl TestDir {
    fn fixture() -> Result<(Self, PathBuf, ProxyCache), Box<dyn std::error::Error>> {
        let path = std::env::temp_dir().join(format!("aster-proxy-test-{}", Uuid::new_v4()));
        fs::create_dir(&path)?;
        let source = path.join("source.mov");
        fs::write(&source, b"stable source bytes")?;
        let cache = ProxyCache {
            root: path.join("cache"),
            limits: ProxyLimits::default(),
        };
        Ok((Self(path), source, cache))
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn plan_identity_is_content_and_profile_addressed() -> Result<(), Box<dyn std::error::Error>> {
    let (_root, source, cache) = TestDir::fixture()?;
    let token = CancellationToken::default();
    let first = cache.prepare(&source, "ffmpeg", ProxyProfile::default(), &token)?;
    let second = cache.prepare(&source, "ffmpeg", ProxyProfile::default(), &token)?;
    assert_eq!(first.output(), second.output());
    assert_eq!(first.metadata(), second.metadata());
    assert_ne!(first.temporary_output(), second.temporary_output());
    assert_eq!(
        first.arguments().last().map(OsString::as_os_str),
        Some(first.temporary_output().as_os_str())
    );
    Ok(())
}

#[test]
fn finalization_and_source_invalidation_are_safe() -> Result<(), Box<dyn std::error::Error>> {
    let (_root, source, cache) = TestDir::fixture()?;
    let token = CancellationToken::default();
    let plan = cache.prepare(&source, "ffmpeg", ProxyProfile::default(), &token)?;
    fs::write(plan.temporary_output(), b"proxy")?;
    plan.finalize(&token)?;
    assert_eq!(
        cache.inspect(
            &source,
            plan.output(),
            plan.metadata_path(),
            &plan.metadata().profile,
            &token
        )?,
        ProxyValidity::Valid
    );
    // Same byte length proves invalidation is content-based rather than a size shortcut.
    fs::write(&source, b"mutable source byte")?;
    assert_eq!(
        cache.inspect(
            &source,
            plan.output(),
            plan.metadata_path(),
            &plan.metadata().profile,
            &token
        )?,
        ProxyValidity::SourceChanged
    );
    Ok(())
}

#[test]
fn cancellation_prevents_planning_and_publication() -> Result<(), Box<dyn std::error::Error>> {
    let (_root, source, cache) = TestDir::fixture()?;
    let token = CancellationToken::default();
    token.cancel();
    assert!(matches!(
        cache.prepare(source, "ffmpeg", ProxyProfile::default(), &token),
        Err(ProxyError::Cancelled)
    ));
    Ok(())
}

#[test]
fn rejects_oversized_metadata_before_json_parsing() -> Result<(), Box<dyn std::error::Error>> {
    let (_root, source, cache) = TestDir::fixture()?;
    let proxy = _root.0.join("proxy.mp4");
    let metadata = _root.0.join("proxy.json");
    fs::write(&proxy, b"proxy")?;
    fs::write(
        &metadata,
        vec![b' '; cache.limits.max_metadata_bytes as usize + 1],
    )?;
    assert!(matches!(
        cache.inspect(
            source,
            proxy,
            metadata,
            &ProxyProfile::default(),
            &CancellationToken::default(),
        ),
        Err(ProxyError::MetadataTooLarge(_))
    ));
    Ok(())
}

#[test]
fn changed_sources_never_publish_and_plan_clones_retain_staging()
-> Result<(), Box<dyn std::error::Error>> {
    let (_root, source, cache) = TestDir::fixture()?;
    let token = CancellationToken::default();
    let plan = cache.prepare(&source, "ffmpeg", ProxyProfile::default(), &token)?;
    let snapshot = plan._artifacts._snapshot.temporary.clone();
    let pending_output = plan.temporary_output().to_owned();
    let retained = plan.clone();
    drop(plan);
    fs::write(&source, b"changed during encoding")?;
    assert_eq!(fs::read(&snapshot)?, b"stable source bytes");
    fs::write(&pending_output, b"encoded snapshot")?;
    assert!(matches!(
        retained.finalize(&token),
        Err(ProxyError::SourceChanged)
    ));
    assert!(!retained.output().exists());
    assert!(!retained.metadata_path().exists());
    drop(retained);
    assert!(!snapshot.exists());
    assert!(!pending_output.exists());
    Ok(())
}

#[test]
#[ignore = "requires FFmpeg with the libx264 encoder"]
fn ffmpeg_encodes_the_captured_source_and_publishes_a_valid_proxy()
-> Result<(), Box<dyn std::error::Error>> {
    let (_root, source, cache) = TestDir::fixture()?;
    let generated = std::process::Command::new("ffmpeg")
        .args([
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=64x48:r=10",
            "-t",
            "0.2",
            "-c:v",
            "libx264",
        ])
        .arg(&source)
        .output()?;
    assert!(
        generated.status.success(),
        "{}",
        String::from_utf8_lossy(&generated.stderr)
    );
    let token = CancellationToken::default();
    let plan = cache.prepare(&source, "ffmpeg", ProxyProfile::default(), &token)?;
    let encoded = std::process::Command::new(plan.program())
        .args(plan.arguments())
        .output()?;
    assert!(
        encoded.status.success(),
        "{}",
        String::from_utf8_lossy(&encoded.stderr)
    );
    plan.finalize(&token)?;
    assert_eq!(
        cache.inspect(
            &source,
            plan.output(),
            plan.metadata_path(),
            &ProxyProfile::default(),
            &token
        )?,
        ProxyValidity::Valid
    );
    Ok(())
}

use std::{path::PathBuf, time::SystemTime};

use super::*;

struct Fixture {
    directory: PathBuf,
}

impl Fixture {
    fn create() -> Result<Self, Box<dyn std::error::Error>> {
        let nonce = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)?
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("aster-effect-shots-{}-{nonce}", std::process::id()));
        fs::create_dir(&directory)?;
        Ok(Self { directory })
    }

    fn manifest() -> EffectManifest {
        EffectManifest {
            schema_version: 1,
            kind: "effect-shot-ops".to_owned(),
            width: 640,
            height: 360,
            time: 0.5,
            parameter_source: "registry-defaults".to_owned(),
            registry_types: vec!["exposure".to_owned()],
            corpus_sha256: "a".repeat(64),
            shader_manifest_sha256: format!(
                "{:x}",
                Sha256::digest(include_bytes!("../../../../shaders/manifest.json"))
            ),
            shader_programs: Vec::new(),
            effects: vec![EffectEntry {
                effect_type: "exposure".to_owned(),
                name: "Exposure".to_owned(),
                case_id: "effect-exposure".to_owned(),
                ops: vec![vec![0.0; 16]],
            }],
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn operations_reject_incomplete_coverage_unsafe_paths_and_truncated_data() -> Result<(), String> {
    let mut manifest = Fixture::manifest();
    manifest.validate()?;
    manifest.registry_types.push("blur".to_owned());
    assert!(manifest.validate().is_err());
    manifest.registry_types.pop();
    manifest.effects[0].case_id = "effect-blur".to_owned();
    assert!(manifest.validate().is_err());
    manifest.effects[0].case_id = "effect-exposure".to_owned();
    manifest.effects[0].ops[0].pop();
    assert!(manifest.validate().is_err());
    manifest.effects[0].ops[0].push(f32::INFINITY);
    assert!(manifest.validate().is_err());
    manifest.effects[0].ops.clear();
    assert!(manifest.validate().is_err());
    manifest.effects[0].ops = vec![vec![0.0; 16]; 65];
    assert!(manifest.validate().is_err());
    manifest.effects[0].ops.truncate(1);
    manifest.effects[0].effect_type = "../exposure".to_owned();
    manifest.registry_types[0] = "../exposure".to_owned();
    manifest.effects[0].case_id = "effect-../exposure".to_owned();
    assert!(manifest.validate().is_err());
    Ok(())
}

#[test]
fn shared_catalog_hashes_are_required_and_dumped_wgsl_is_never_read()
-> Result<(), Box<dyn std::error::Error>> {
    let fixture = Fixture::create()?;
    let catalog = ShaderCatalog::embedded()?;
    let mut manifest = Fixture::manifest();
    for id in ["post-process", "blur-downsample", "brightpass-downsample"] {
        manifest.shader_programs.push(ShaderDigest {
            id: id.to_owned(),
            sha256: format!(
                "{:x}",
                Sha256::digest(catalog.program(id)?.source.as_bytes())
            ),
        });
        fs::write(
            fixture.directory.join(format!("{id}.wgsl")),
            "untrusted stale dump",
        )?;
    }
    let path = fixture.directory.join("effects.json");
    fs::write(&path, serde_json::to_vec(&manifest)?)?;
    let input = HarnessInput::load(&fixture.directory)?;
    assert_eq!(input.post_process, catalog.program("post-process")?.source);
    assert_eq!(
        input.blur_downsample,
        catalog.program("blur-downsample")?.source
    );
    assert_eq!(
        input.brightpass_downsample,
        catalog.program("brightpass-downsample")?.source
    );
    assert_eq!(
        input.manifest_sha256,
        format!("{:x}", Sha256::digest(fs::read(&path)?))
    );
    manifest.shader_programs[0].sha256 = "0".repeat(64);
    fs::write(&path, serde_json::to_vec(&manifest)?)?;
    assert!(HarnessInput::load(&fixture.directory).is_err());
    manifest.shader_manifest_sha256 = "0".repeat(64);
    fs::write(&path, serde_json::to_vec(&manifest)?)?;
    assert!(HarnessInput::load(&fixture.directory).is_err());
    Ok(())
}

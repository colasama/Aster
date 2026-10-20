use aster_media_native::{RadianceLimits, TextureLimits};
use aster_render_ir::{PutResource, ResourceHash};
use aster_render_project::{NativeProjectDocument, NativeProjectMaterials, ProjectRenderLimits};
use aster_video::CancellationToken;
use clap::Parser;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::PathBuf};

#[derive(Parser)]
struct Options {
    #[command(flatten)]
    project: ProjectRenderLimits,
    #[command(flatten)]
    textures: TextureLimits,
    #[command(flatten)]
    radiance: RadianceLimits,
}
#[derive(Deserialize)]
struct Proof {
    path: PathBuf,
    sha256: String,
}
#[derive(Deserialize)]
struct Input {
    sources: Vec<Proof>,
    packets: Vec<Packet>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
struct Packet {
    message: PutResource,
    sha256: String,
    decoded_sha256: Option<String>,
}
#[derive(Deserialize)]
struct Case {
    id: String,
    project: Option<Proof>,
    inline: Option<serde_json::Value>,
    composition: String,
    samples: Vec<Sample>,
}
#[derive(Deserialize)]
struct Sample {
    time: f64,
    bindings: Bindings,
    hashes: Vec<ResourceHash>,
}
#[derive(Deserialize)]
struct Bindings {
    normals: BTreeMap<String, ResourceHash>,
    environment: Option<ResourceHash>,
}

#[test]
#[ignore = "requires independent TS material acquisition oracle"]
fn native_project_materials_match_ts() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()?;
    let input: Input =
        serde_json::from_slice(&fs::read(std::env::var("ASTER_PROJECT_MATERIAL_ORACLE")?)?)?;
    for proof in input.sources {
        assert_eq!(
            format!("{:x}", Sha256::digest(fs::read(root.join(proof.path))?)),
            proof.sha256
        );
    }
    let packets = input
        .packets
        .into_iter()
        .map(|p| (p.message.hash.clone(), p))
        .collect::<BTreeMap<_, _>>();
    let temporary = root.join("artifacts/migration/native-material-oracle-inputs");
    fs::create_dir_all(&temporary)?;
    let token = CancellationToken::default();
    for (index, case) in input.cases.into_iter().enumerate() {
        let path = if let Some(proof) = case.project {
            let path = root.join(proof.path);
            assert_eq!(
                format!("{:x}", Sha256::digest(fs::read(&path)?)),
                proof.sha256
            );
            path
        } else {
            let path = temporary.join(format!("{index}.json"));
            fs::write(
                &path,
                serde_json::to_vec(&case.inline.ok_or("inline project absent")?)?,
            )?;
            path
        };
        let options = Options::try_parse_from(["test"])?;
        let document = NativeProjectDocument::open(&path, options.project)?;
        let mut session = NativeProjectMaterials::new(
            root.join("build/ffmpeg/ffmpeg.exe"),
            options.textures,
            options.radiance,
        )?;
        for sample in case.samples {
            let frame = session.acquire(&document, &case.composition, sample.time, &token)?;
            assert_eq!(
                frame.bindings.normals, sample.bindings.normals,
                "{}",
                case.id
            );
            assert_eq!(
                frame.bindings.environment, sample.bindings.environment,
                "{}",
                case.id
            );
            assert_eq!(
                frame
                    .resources
                    .iter()
                    .map(|r| r.request().hash.clone())
                    .collect::<Vec<_>>(),
                sample.hashes,
                "{}",
                case.id
            );
            for resource in frame.resources {
                let expected = packets
                    .get(&resource.request().hash)
                    .ok_or("unexpected material resource")?;
                assert_eq!(resource.request(), &expected.message);
                assert_eq!(
                    format!("{:x}", Sha256::digest(resource.bytes())),
                    expected.sha256
                );
            }
            for decoded in frame.decoded {
                if let Some(hash) = &packets
                    .get(&decoded.encoded)
                    .ok_or("encoded texture absent")?
                    .decoded_sha256
                {
                    assert_eq!(
                        &format!("{:x}", Sha256::digest(decoded.pixels.bytes())),
                        hash,
                        "{}",
                        case.id
                    );
                }
            }
        }
    }
    Ok(())
}

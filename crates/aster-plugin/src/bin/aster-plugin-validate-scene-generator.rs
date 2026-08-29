use std::{collections::BTreeMap, error::Error, io::Read};

use aster_plugin::{PluginManifest, validate_scene_generator_sources};
use serde::Deserialize;

const MAX_INPUT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationPackage {
    manifest: PluginManifest,
    shader_sources: BTreeMap<String, String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut input = String::new();
    std::io::stdin()
        .take(MAX_INPUT_BYTES + 1)
        .read_to_string(&mut input)?;
    if input.len() as u64 > MAX_INPUT_BYTES {
        return Err("scene-generator validation package exceeds 16 MiB".into());
    }
    let package: ValidationPackage = serde_json::from_str(&input)?;
    validate_scene_generator_sources(&package.manifest, &package.shader_sources)?;
    Ok(())
}

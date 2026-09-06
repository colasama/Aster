use std::{collections::BTreeMap, error::Error, io::Read};

use aster_plugin::{PluginLimits, PluginManifest, SceneGeneratorValidator};
use clap::Parser;
use serde::Deserialize;

#[derive(Parser)]
struct ValidationOptions {
    #[arg(long, default_value_t = 16 * 1024 * 1024)]
    max_input_bytes: u64,
    #[command(flatten)]
    limits: PluginLimits,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ValidationPackage {
    manifest: PluginManifest,
    shader_sources: BTreeMap<String, String>,
}

fn main() {
    if let Err(error) = ValidationOptions::parse().run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

impl ValidationOptions {
    fn run(self) -> Result<(), Box<dyn Error>> {
        let mut input = String::new();
        std::io::stdin()
            .take(self.max_input_bytes.saturating_add(1))
            .read_to_string(&mut input)?;
        if input.len() as u64 > self.max_input_bytes {
            return Err(
                "scene-generator validation package exceeds the configured byte limit".into(),
            );
        }
        let package: ValidationPackage = serde_json::from_str(&input)?;
        SceneGeneratorValidator {
            limits: self.limits,
        }
        .validate(&package.manifest, &package.shader_sources)?;
        Ok(())
    }
}

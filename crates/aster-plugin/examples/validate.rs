use clap::Parser;
use std::{path::PathBuf, process::ExitCode};

#[derive(Parser)]
struct ValidationOptions {
    directory: PathBuf,
    #[command(flatten)]
    limits: aster_plugin::PluginLimits,
}

fn main() -> ExitCode {
    let options = ValidationOptions::parse();
    match options
        .limits
        .load(options.directory.join("plugin.toml"), true)
    {
        Ok(package) => {
            let manifest = package.manifest;
            println!(
                "validated {} v{} against Aster plugin API v{}",
                manifest.plugin.id, manifest.plugin.version, manifest.plugin.api_version
            );
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("plugin validation failed: {error}");
            ExitCode::FAILURE
        }
    }
}

use std::{env, path::PathBuf, process::ExitCode};

fn main() -> ExitCode {
    let Some(directory) = env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("usage: cargo run -p aster-plugin --example validate -- <plugin-directory>");
        return ExitCode::FAILURE;
    };
    match aster_plugin::PluginLimits::default().load(directory.join("plugin.toml"), true) {
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

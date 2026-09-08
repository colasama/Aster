use std::{
    env, io,
    process::{Command, ExitCode},
};

use clap::Parser;

#[derive(Parser)]
#[command(about = "Connect MCP over stdio to Aster without credentials")]
struct Mcp {
    /// Start an isolated background editor instead of connecting to the open editor.
    #[arg(long)]
    background: bool,
}

impl Mcp {
    fn run(self) -> io::Result<ExitCode> {
        let executable = env::current_exe()?;
        let resources = executable
            .parent()
            .and_then(|bin| bin.parent())
            .ok_or_else(|| io::Error::other("MCP launcher must be installed in resources/bin"))?;
        let application = resources
            .parent()
            .ok_or_else(|| io::Error::other("Aster installation directory is missing"))?;
        let runtime = if cfg!(target_os = "windows") {
            application.join("Aster.exe")
        } else if cfg!(target_os = "macos") {
            application.join("MacOS/Aster")
        } else {
            application.join("aster")
        };
        let mut command = Command::new(runtime);
        command
            .env("ELECTRON_RUN_AS_NODE", "1")
            .arg(resources.join("app.asar/dist-electron/electron/automation-mcp.js"));
        if self.background {
            command.arg("--background");
        }
        let status = command.status()?;
        Ok(ExitCode::from(
            u8::try_from(status.code().unwrap_or(1)).unwrap_or(1),
        ))
    }
}

fn main() -> io::Result<ExitCode> {
    Mcp::parse().run()
}

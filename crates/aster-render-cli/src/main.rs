mod bundle;
mod compare;
mod ir;
mod render_plan;

use std::process::ExitCode;

use clap::{Parser, Subcommand};
use serde::Serialize;

use compare::CompareArgs;

#[derive(Parser)]
#[command(version, about = "Aster renderer verification tools")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Compare lossless RGBA pixels against a fixed tolerance profile.
    Compare(CompareArgs),
    /// Generate schemas and round-trip the bounded partial frame-plan transport.
    Ir(ir::IrArgs),
    /// Execute a complete supplied frame on a native GPU, with optional diagnostic PNG output.
    RenderPlan(render_plan::RenderPlanArgs),
}

#[derive(Serialize)]
struct Failure {
    schema_version: u32,
    error: String,
}

impl Cli {
    fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        match self.command {
            Command::Compare(arguments) => arguments.run(),
            Command::Ir(arguments) => Ok(arguments.run()),
            Command::RenderPlan(arguments) => arguments.run(),
        }
    }
}

fn main() -> ExitCode {
    match Cli::parse().run() {
        Ok(code) => code,
        Err(error) => {
            let failure = Failure {
                schema_version: 1,
                error: error.to_string(),
            };
            match serde_json::to_string(&failure) {
                Ok(json) => println!("{json}"),
                Err(error) => eprintln!("Failed to serialize comparison error: {error}"),
            }
            ExitCode::from(2)
        }
    }
}

mod bundle;
mod compare;
#[cfg(all(test, windows))]
mod encoder_qualification;
mod export_project;
mod export_witness;
mod ir;
mod native_stills;
mod native_textures;
mod plan_diff;
mod plan_input;
mod plan_project;
mod prepare_rasters;
mod prepare_resources;
mod project_capture;
mod project_runtime;
mod render_input;
mod render_plan;
mod render_project;
mod serve;
mod text_layout;

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
    /// Export an authored project using native evaluation, rendering, audio and hardware encoding.
    Export(Box<export_project::ExportProjectArgs>),
    /// Compare lossless RGBA pixels against a fixed tolerance profile.
    Compare(CompareArgs),
    /// Generate schemas and round-trip the bounded partial frame-plan transport.
    Ir(ir::IrArgs),
    /// Execute a complete supplied frame on a native GPU, with optional diagnostic PNG output.
    RenderPlan(Box<render_plan::RenderPlanArgs>),
    /// Evaluate admitted projects and execute native frames without supplied plans.
    RenderProject(Box<render_project::RenderProjectArgs>),
    /// Evaluate a project snapshot in Rust and publish an authenticated frame bundle.
    PlanProject(Box<plan_project::PlanProjectArgs>),
    /// Prepare retained raster requests using native scene, clock and exposure evaluation.
    PrepareRasters(Box<prepare_rasters::PrepareRastersArgs>),
    /// Prepare ordered root and recursive resources from native project evaluation.
    PrepareResources(Box<prepare_resources::PrepareResourcesArgs>),
    /// Compare authenticated plan structure and typed numeric payloads.
    PlanDiff(Box<plan_diff::PlanDiffArgs>),
    /// Exchange bounded controls and binary supplied-frame resources with the application host.
    Serve(Box<serve::ServeArgs>),
    /// Observe bounded native text shaping and line layout without producing raster pixels.
    TextLayout(Box<text_layout::TextLayoutArgs>),
}

#[derive(Serialize)]
struct Failure {
    schema_version: u32,
    error: String,
}

impl Cli {
    fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        match self.command {
            Command::Export(arguments) => arguments.run(),
            Command::Compare(arguments) => arguments.run(),
            Command::Ir(arguments) => Ok(arguments.run()),
            Command::RenderPlan(arguments) => arguments.run(),
            Command::RenderProject(arguments) => arguments.run(),
            Command::PlanProject(arguments) => arguments.run(),
            Command::PrepareRasters(arguments) => arguments.run(),
            Command::PrepareResources(arguments) => arguments.run(),
            Command::PlanDiff(arguments) => arguments.run(),
            Command::Serve(arguments) => arguments.run(),
            Command::TextLayout(arguments) => arguments.run(),
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

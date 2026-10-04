use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

use aster_render_ir::{
    DecodeLimits, FplnCodec, FramePlanSchema, IrError, IrFixture, ResourceLimits, ResourceMessage,
    ResourceRegistry,
};
use clap::{Args, Subcommand};
use serde::Serialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Args)]
pub struct IrArgs {
    #[command(subcommand)]
    command: IrCommand,
}

#[derive(Debug, Subcommand)]
enum IrCommand {
    /// Validate and replay descriptor-only media resource messages, then emit typed JSON.
    Resources {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    /// Emit the deterministic schema for the declared partial transport contract.
    Schema {
        #[arg(long)]
        out: PathBuf,
    },
    /// Decode typed metadata and blobs, then encode a new canonical FPLN container.
    Roundtrip {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[command(flatten)]
        limits: IrLimits,
    },
    /// Write an independent Rust numeric fixture; no renderer or GPU is used.
    Fixture {
        #[arg(long)]
        output: PathBuf,
    },
    /// Print the validated metadata without pretending to render the incomplete plan.
    Dump {
        #[arg(long)]
        input: PathBuf,
        #[command(flatten)]
        limits: IrLimits,
    },
}

#[derive(Debug, Args)]
struct IrLimits {
    #[arg(long, default_value_t = DecodeLimits::default().max_container_bytes)]
    max_container_bytes: usize,
    #[arg(long, default_value_t = DecodeLimits::default().max_metadata_bytes)]
    max_metadata_bytes: usize,
    #[arg(long, default_value_t = DecodeLimits::default().max_blobs)]
    max_blobs: usize,
    #[arg(long, default_value_t = DecodeLimits::default().max_slices)]
    max_slices: usize,
    #[arg(long, default_value_t = DecodeLimits::default().max_resource_references)]
    max_resource_references: usize,
    #[arg(long, default_value_t = DecodeLimits::default().max_dimension)]
    max_dimension: u32,
    #[arg(long, default_value_t = DecodeLimits::default().max_pixels)]
    max_pixels: u64,
}

impl From<IrLimits> for DecodeLimits {
    fn from(value: IrLimits) -> Self {
        Self {
            max_container_bytes: value.max_container_bytes,
            max_metadata_bytes: value.max_metadata_bytes,
            max_blobs: value.max_blobs,
            max_slices: value.max_slices,
            max_resource_references: value.max_resource_references,
            max_dimension: value.max_dimension,
            max_pixels: value.max_pixels,
        }
    }
}

#[derive(Serialize)]
struct IrSuccess {
    schema_version: u32,
    status: &'static str,
    kind: &'static str,
    path: PathBuf,
    sha256: String,
    bytes: usize,
}

#[derive(Serialize)]
struct IrFailure {
    schema_version: u32,
    status: &'static str,
    code: &'static str,
    error: String,
}

impl IrArgs {
    pub fn run(self) -> ExitCode {
        match self.execute() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                let failure = IrFailure {
                    schema_version: 1,
                    status: "failed",
                    code: error.code(),
                    error: error.to_string(),
                };
                match serde_json::to_string(&failure) {
                    Ok(json) => println!("{json}"),
                    Err(error) => eprintln!("Failed to serialize IR error: {error}"),
                }
                ExitCode::from(2)
            }
        }
    }

    fn execute(self) -> Result<(), IrError> {
        let (kind, output, bytes) = match self.command {
            IrCommand::Resources { input, output } => {
                let input = Self::read_bounded(&input, &DecodeLimits::default())?;
                let messages: Vec<ResourceMessage> = serde_json::from_slice(&input)
                    .map_err(|error| IrError::InvalidJson(error.to_string()))?;
                let mut registry = ResourceRegistry::new(ResourceLimits::default())?;
                for message in &messages {
                    match message {
                        ResourceMessage::PutResource(request) => {
                            registry.put(request.clone(), Vec::new())?;
                        }
                        ResourceMessage::EvictResource { hash } => registry.evict(hash)?,
                    }
                }
                let bytes = serde_json::to_vec(&messages)
                    .map_err(|error| IrError::InvalidJson(error.to_string()))?;
                ("ir_resources", output, bytes)
            }
            IrCommand::Schema { out } => ("ir_schema", out, FramePlanSchema::emit()?),
            IrCommand::Fixture { output } => (
                "ir_fixture",
                output,
                IrFixture::encode(&DecodeLimits::default())?,
            ),
            IrCommand::Roundtrip {
                input,
                output,
                limits,
            } => {
                let limits = DecodeLimits::from(limits);
                let input = Self::read_bounded(&input, &limits)?;
                let decoded = FplnCodec::decode(input, &limits)?;
                ("ir_roundtrip", output, decoded.reencode(&limits)?)
            }
            IrCommand::Dump { input, limits } => {
                let limits = DecodeLimits::from(limits);
                let bytes = Self::read_bounded(&input, &limits)?;
                let decoded = FplnCodec::decode(bytes, &limits)?;
                let json = String::from_utf8(decoded.metadata_json(&limits)?)
                    .map_err(|_| IrError::InvalidUtf8)?;
                println!("{json}");
                return Ok(());
            }
        };
        Self::publish(&output, &bytes)?;
        let report = IrSuccess {
            schema_version: 1,
            status: "passed",
            kind,
            path: output,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
            bytes: bytes.len(),
        };
        println!(
            "{}",
            serde_json::to_string(&report)
                .map_err(|error| IrError::InvalidJson(error.to_string()))?
        );
        Ok(())
    }

    fn read_bounded(path: &Path, limits: &DecodeLimits) -> Result<Vec<u8>, IrError> {
        limits.validate()?;
        let file = File::open(path)?;
        let maximum =
            u64::try_from(limits.max_container_bytes).map_err(|_| IrError::ArithmeticOverflow)?;
        if file.metadata()?.len() > maximum {
            return Err(IrError::LimitExceeded("input file bytes".to_owned()));
        }
        let mut bytes = Vec::new();
        file.take(maximum.checked_add(1).ok_or(IrError::ArithmeticOverflow)?)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limits.max_container_bytes {
            return Err(IrError::LimitExceeded(
                "input file grew during read".to_owned(),
            ));
        }
        Ok(bytes)
    }

    fn publish(path: &Path, bytes: &[u8]) -> Result<(), IrError> {
        let parent = match path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            Some(parent) => parent,
            None => Path::new("."),
        };
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".aster-ir-{}.tmp", Uuid::new_v4()));
        let result = (|| -> Result<(), IrError> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            // Creating a hard link publishes complete bytes without ever replacing an existing output.
            fs::hard_link(&temporary, path)?;
            Ok(())
        })();
        let cleanup = fs::remove_file(&temporary);
        result?;
        cleanup?;
        Ok(())
    }
}

use aster_project::{AtomicFile, RuntimeProjectDocument, RuntimeProjectLimits};
use clap::Args;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
    process::ExitCode,
};

#[derive(Debug, Args)]
pub(crate) struct NormalizeProjectArgs {
    #[arg(long)]
    project: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long, default_value_t = 67_108_864)]
    max_input_bytes: usize,
}

#[derive(Serialize)]
struct NormalizeReceipt {
    status: &'static str,
    source_schema_version: u64,
    authored_sha256: String,
    normalized_sha256: String,
    normalized_bytes: usize,
}

impl NormalizeProjectArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        if !(32..=268_435_456).contains(&self.max_input_bytes) || self.out.try_exists()? {
            return Err("normalization requires bounded input and a new destination".into());
        }
        let file = File::open(&self.project)?;
        if !file.metadata()?.is_file() || file.metadata()?.len() > self.max_input_bytes as u64 {
            return Err("normalization input exceeds its byte budget".into());
        }
        let mut bytes = Vec::new();
        file.take(self.max_input_bytes as u64 + 1)
            .read_to_end(&mut bytes)?;
        let document = RuntimeProjectDocument::from_slice(
            &bytes,
            &RuntimeProjectLimits {
                max_input_bytes: self.max_input_bytes,
                max_output_bytes: self.max_input_bytes,
                ..RuntimeProjectLimits::default()
            },
        )?;
        let normalized = document.encode()?;
        let receipt = NormalizeReceipt {
            status: "passed",
            source_schema_version: document.source_version(),
            authored_sha256: format!("{:x}", Sha256::digest(bytes)),
            normalized_sha256: format!("{:x}", Sha256::digest(&normalized)),
            normalized_bytes: normalized.len(),
        };
        let (pending, mut output) = AtomicFile::stage(&self.out)?;
        output.write_all(&normalized)?;
        drop(output);
        pending.publish(false)?;
        println!("{}", serde_json::to_string(&receipt)?);
        Ok(ExitCode::SUCCESS)
    }
}

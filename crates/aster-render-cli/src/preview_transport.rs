use aster_render::AdapterDiagnostics;
use aster_render_ir::Extent2d;
use aster_renderer::{PreviewConsumer, SharedPreviewFrame};
use clap::Args;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant},
};

#[derive(Debug, Args)]
pub(crate) struct PreviewTransportArgs {
    /// Supplied only by the trusted main process which imports the shared texture.
    #[arg(long)]
    consumer_pid: u32,
    #[arg(long, default_value_t = 2)]
    pub slots: u32,
    #[arg(long, default_value_t = 4096)]
    max_control_bytes: usize,
    #[arg(long, default_value_t = 5000)]
    handle_guard_timeout_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum PreviewSource {
    Plan {
        sha256: String,
    },
    Project {
        authored_sha256: String,
        runtime_sha256: String,
        scope: String,
        revision: u64,
        composition_id: String,
    },
}

#[derive(Clone, Serialize)]
pub(crate) struct PreviewDescription {
    pub adapter: AdapterDiagnostics,
    pub width: u32,
    pub height: u32,
    pub source: PreviewSource,
}

pub(crate) trait PreviewProducer {
    fn describe(&self) -> Result<PreviewDescription, Box<dyn std::error::Error>>;
    fn render(
        &mut self,
        time: Option<f64>,
    ) -> Result<PreviewProducedFrame, Box<dyn std::error::Error>>;
    fn replace(
        &mut self,
        _project: &Path,
        _request: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        Err("fixed preview source cannot be replaced".into())
    }
}

#[derive(Serialize)]
pub(crate) struct PreviewFrameTimings {
    pub prepare_ms: f64,
    pub raster_ms: f64,
    pub render_ms: f64,
    pub share_ms: f64,
}

pub(crate) struct PreviewProducedFrame {
    pub surface: SharedPreviewFrame,
    pub timings: Option<PreviewFrameTimings>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum PreviewCommand {
    Present {
        sequence: u64,
        generation: u64,
        time: Option<f64>,
    },
    Replace {
        generation: u64,
        project: PathBuf,
        request: PathBuf,
    },
    Release {
        sequence: u64,
    },
    Shutdown {},
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PreviewReply {
    Ready {
        schema_version: u32,
        generation: u64,
        slots: u32,
        #[serde(flatten)]
        description: PreviewDescription,
    },
    Frame {
        sequence: u64,
        generation: u64,
        time: Option<f64>,
        nt_handle: Vec<u8>,
        render_and_share_ms: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        timings: Option<PreviewFrameTimings>,
    },
    Released {
        sequence: u64,
    },
    Stopped {},
}

impl PreviewReply {
    fn write(&self, output: &mut impl Write) -> Result<(), Box<dyn std::error::Error>> {
        serde_json::to_writer(&mut *output, self)?;
        output.write_all(b"\n")?;
        output.flush()?;
        Ok(())
    }
}

impl PreviewTransportArgs {
    pub fn serve(
        self,
        producer: &mut impl PreviewProducer,
    ) -> Result<ExitCode, Box<dyn std::error::Error>> {
        if !(64..=65_536).contains(&self.max_control_bytes) || !(1..=3).contains(&self.slots) {
            return Err("invalid preview transport limits".into());
        }
        let consumer = PreviewConsumer::open(
            self.consumer_pid,
            &std::env::current_exe()?,
            self.slots,
            self.max_control_bytes,
            Duration::from_millis(self.handle_guard_timeout_ms),
        )?;
        let mut output = io::BufWriter::new(io::stdout().lock());
        let mut generation = 1;
        let mut description = producer.describe()?;
        PreviewReply::Ready {
            schema_version: 1,
            generation,
            slots: self.slots,
            description: description.clone(),
        }
        .write(&mut output)?;
        let mut reader = io::BufReader::new(io::stdin().lock());
        let mut leases = BTreeMap::new();
        let mut latest = 0;
        loop {
            let mut bytes = Vec::new();
            let count = reader
                .by_ref()
                .take(self.max_control_bytes as u64 + 1)
                .read_until(b'\n', &mut bytes)?;
            if count == 0 {
                return Ok(ExitCode::SUCCESS);
            }
            if count > self.max_control_bytes || bytes.last() != Some(&b'\n') {
                return Err("preview control exceeds limit or is incomplete".into());
            }
            match serde_json::from_slice::<PreviewCommand>(&bytes)? {
                PreviewCommand::Present {
                    sequence,
                    generation: requested,
                    time,
                } => {
                    if requested != generation
                        || sequence <= latest
                        || leases.len() >= self.slots as usize
                        || time.is_some_and(|t| !t.is_finite())
                    {
                        return Err(
                            "stale preview sequence, invalid time or exhausted surface leases"
                                .into(),
                        );
                    }
                    let started = Instant::now();
                    let produced = producer.render(time)?;
                    let shared = produced.surface;
                    if shared.size()
                        != (Extent2d {
                            width: description.width,
                            height: description.height,
                        })
                    {
                        return Err("preview generation extent changed".into());
                    }
                    let remote = consumer.transfer(shared)?;
                    let nt_handle = remote.handle_bytes();
                    leases.insert(sequence, remote);
                    latest = sequence;
                    PreviewReply::Frame {
                        sequence,
                        generation,
                        time,
                        nt_handle,
                        render_and_share_ms: started.elapsed().as_secs_f64() * 1000.0,
                        timings: produced.timings,
                    }
                    .write(&mut output)?;
                }
                PreviewCommand::Replace {
                    generation: requested,
                    project,
                    request,
                } => {
                    if !leases.is_empty() || generation.checked_add(1) != Some(requested) {
                        return Err(
                            "replacement requires drained leases and next generation".into()
                        );
                    }
                    producer.replace(&project, &request)?;
                    description = producer.describe()?;
                    generation = requested;
                    PreviewReply::Ready {
                        schema_version: 1,
                        generation,
                        slots: self.slots,
                        description: description.clone(),
                    }
                    .write(&mut output)?;
                }
                PreviewCommand::Release { sequence } => {
                    if leases.remove(&sequence).is_none() {
                        return Err("unknown or already released preview sequence".into());
                    }
                    PreviewReply::Released { sequence }.write(&mut output)?;
                }
                PreviewCommand::Shutdown {} => {
                    if !leases.is_empty() {
                        return Err("preview shutdown requires all consumer releases".into());
                    }
                    PreviewReply::Stopped {}.write(&mut output)?;
                    return Ok(ExitCode::SUCCESS);
                }
            }
        }
    }
}

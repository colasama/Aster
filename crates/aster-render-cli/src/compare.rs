use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::ExitCode,
    time::Instant,
};

use aster_render_compare::{
    artifacts::{ArtifactOptions, ArtifactPaths, ArtifactRenameOptions, ArtifactWriter},
    comparison::{Comparison, ComparisonOptions, ComparisonReport},
    error::CompareError,
    image::{ImageLimits, RgbaImage},
    png::PngCodec,
    registration::RegistrationOptions,
    sequence::SequenceInput,
};
use clap::Args;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Debug, Args)]
pub struct CompareArgs {
    #[arg(long)]
    reference: PathBuf,
    #[arg(long)]
    candidate: PathBuf,
    #[arg(long,default_value="gpu",value_parser=["exact","gpu","decode","yuv","perceptual"])]
    tolerance: String,
    /// New evidence directory. Existing destinations are never overwritten.
    #[arg(long)]
    out: Option<PathBuf>,
    /// JSON with isolated/background and sequence frame/domain/neighbor paths.
    #[arg(long)]
    context: Option<PathBuf>,
    #[arg(long, default_value_t = 16_777_216)]
    max_pixels: usize,
    #[arg(long, default_value_t = 134_217_728)]
    max_file_bytes: usize,
    #[arg(long, default_value_t = 1_073_741_824)]
    registration_memory_bytes: usize,
    #[arg(long, default_value_t = 16)]
    heatmap_gain: u16,
    /// Maximum final artifact-directory rename attempts on Windows access/sharing failures.
    #[arg(long, default_value_t = 5, value_parser = clap::value_parser!(u8).range(1..=5))]
    artifact_rename_attempts: u8,
    /// Initial retry delay in milliseconds, doubled after each failed rename.
    #[arg(long, default_value_t = 20, value_parser = clap::value_parser!(u64).range(1..=50))]
    artifact_rename_delay_ms: u64,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CaseContext {
    case_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    g5_uniform_reference: Option<bool>,
    #[serde(default)]
    isolated: bool,
    background: Option<[u8; 4]>,
    sequence: Option<SequenceContext>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SequenceContext {
    frame: u64,
    first_frame: u64,
    last_frame: u64,
    previous: Option<PathBuf>,
    next: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
struct ImageInput {
    path: PathBuf,
    png_sha256: String,
    file_bytes: usize,
}

#[derive(Serialize)]
struct FileComparison {
    schema_version: u32,
    tool_version: String,
    duration_ms: u128,
    presentation: Presentation,
    reference: ImageInput,
    candidate: ImageInput,
    previous: Option<ImageInput>,
    next: Option<ImageInput>,
    context: CaseContext,
    comparison: ComparisonReport,
}

#[derive(Serialize)]
struct Presentation {
    heatmap_gain: u16,
    heatmap_channels: String,
    contact_sheet_layout: String,
    rgb_convention: String,
}

#[derive(Serialize)]
struct ComparisonOutput {
    report: FileComparison,
    artifacts: ArtifactPaths,
}

impl ImageInput {
    fn load(path: &Path, limits: &ImageLimits) -> Result<(Self, RgbaImage), CompareError> {
        let path = fs::canonicalize(path)
            .map_err(|error| CompareError::io_at("resolve PNG input", path, error))?;
        let file = File::open(&path)
            .map_err(|error| CompareError::io_at("open PNG input", &path, error))?;
        let read_limit = u64::try_from(limits.max_file_bytes)
            .ok()
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| CompareError::InvalidArgument("Invalid file size budget".into()))?;
        if file
            .metadata()
            .map_err(|error| CompareError::io_at("inspect PNG input", &path, error))?
            .len()
            >= read_limit
        {
            return Err(CompareError::ResourceLimit(format!(
                "PNG exceeds file budget: {}",
                path.display()
            )));
        }
        let mut bytes = Vec::new();
        file.take(read_limit)
            .read_to_end(&mut bytes)
            .map_err(|error| CompareError::io_at("read PNG input", &path, error))?;
        let image = PngCodec::decode(&bytes, limits)?;
        Ok((
            Self {
                path,
                png_sha256: format!("{:x}", Sha256::digest(&bytes)),
                file_bytes: bytes.len(),
            },
            image,
        ))
    }
}

impl CompareArgs {
    pub fn run(self) -> Result<ExitCode, Box<dyn std::error::Error>> {
        let started = Instant::now();
        let limits = ImageLimits {
            max_pixels: self.max_pixels,
            max_file_bytes: self.max_file_bytes,
        };
        let (reference, reference_image) = ImageInput::load(&self.reference, &limits)?;
        let (candidate, candidate_image) = ImageInput::load(&self.candidate, &limits)?;
        let (context, context_base) = if let Some(path) = &self.context {
            let path = fs::canonicalize(path)
                .map_err(|error| CompareError::io_at("resolve case context", path, error))?;
            let mut bytes = Vec::new();
            File::open(&path)
                .map_err(|error| CompareError::io_at("open case context", &path, error))?
                .take(65_537)
                .read_to_end(&mut bytes)
                .map_err(|error| CompareError::io_at("read case context", &path, error))?;
            if bytes.len() > 65_536 {
                return Err(
                    CompareError::ResourceLimit("Case context exceeds 64 KiB".into()).into(),
                );
            }
            let context = serde_json::from_slice::<CaseContext>(&bytes)?;
            let base = path
                .parent()
                .ok_or_else(|| CompareError::InvalidArgument("Context has no parent".into()))?
                .to_path_buf();
            (context, base)
        } else {
            (CaseContext::default(), std::env::current_dir()?)
        };
        let mut previous = None;
        let mut next = None;
        let sequence = if let Some(sequence) = &context.sequence {
            let previous_image = if let Some(path) = &sequence.previous {
                let (input, image) = ImageInput::load(&context_base.join(path), &limits)?;
                previous = Some(input);
                Some(image)
            } else {
                None
            };
            let next_image = if let Some(path) = &sequence.next {
                let (input, image) = ImageInput::load(&context_base.join(path), &limits)?;
                next = Some(input);
                Some(image)
            } else {
                None
            };
            Some(SequenceInput {
                frame: sequence.frame,
                first_frame: sequence.first_frame,
                last_frame: sequence.last_frame,
                previous: previous_image,
                next: next_image,
            })
        } else {
            None
        };
        let comparison = Comparison::measure(
            &reference_image,
            &candidate_image,
            &self.tolerance,
            &ComparisonOptions {
                case_id: context.case_id.clone(),
                g5_uniform_reference: context.g5_uniform_reference == Some(true),
                isolated: context.isolated,
                background: context.background,
                sequence,
                registration: RegistrationOptions {
                    max_working_bytes: self.registration_memory_bytes,
                    ..RegistrationOptions::default()
                },
            },
        )?;
        let passed = comparison.passed;
        let report = FileComparison {
            schema_version: 1,
            tool_version: env!("CARGO_PKG_VERSION").into(),
            duration_ms: started.elapsed().as_millis(),
            presentation: Presentation {
                heatmap_gain: self.heatmap_gain,
                heatmap_channels: "opaque grayscale: min(255, max absolute RGBA error * gain)".into(),
                contact_sheet_layout: "top: reference / candidate over checkerboard; bottom: reference alpha / candidate alpha; full resolution".into(),
                rgb_convention: "production premultiplied sRGB; preview adds checkerboard * (1-alpha); metrics use untouched RGBA8".into(),
            },
            reference,
            candidate,
            previous,
            next,
            context,
            comparison,
        };
        let output = self.out.unwrap_or_else(|| {
            PathBuf::from("artifacts/parity/compare").join(Uuid::new_v4().to_string())
        });
        let output = std::path::absolute(&output)
            .map_err(|error| CompareError::io_at("resolve artifact output", &output, error))?;
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| CompareError::io_at("create artifact parent", parent, error))?;
        }
        let artifacts = ArtifactWriter::publish(
            &output,
            &reference_image,
            &candidate_image,
            &report,
            &ArtifactOptions {
                heatmap_gain: self.heatmap_gain,
                checker_size: 8,
                checker_dark: 64,
                checker_light: 96,
                max_output_pixels: self.max_pixels.checked_mul(5).ok_or_else(|| {
                    CompareError::ResourceLimit("Artifact budget overflow".into())
                })?,
                rename: ArtifactRenameOptions {
                    max_attempts: self.artifact_rename_attempts,
                    base_delay_ms: self.artifact_rename_delay_ms,
                },
            },
        )?;
        println!(
            "{}",
            serde_json::to_string(&ComparisonOutput { report, artifacts })?
        );
        Ok(if passed {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(1)
        })
    }
}

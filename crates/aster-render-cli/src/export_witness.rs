use crate::project_capture::{FrameReceipt, ProjectCapture};
use aster_eval::FramePlanRequest;
use aster_render_compare::image::RgbaImage;
use aster_render_project::{PreparedProjectFrame, ProjectExportObserver, ProjectRenderError};
use aster_renderer::{NativeRenderer, RenderedFrame};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    io::Read,
    path::{Path, PathBuf},
};

pub(crate) struct ExportWitness {
    capture: ProjectCapture,
    destination: PathBuf,
    selected: BTreeSet<u64>,
    frames: Vec<WitnessFrame>,
}

#[derive(Serialize)]
struct WitnessFrame {
    index: u64,
    composition: String,
    time: f64,
    time_bits: String,
    snapshot_scope: String,
    project_revision: u64,
    rgb: FrameReceipt,
    nv12_sha256: String,
    nv12_bytes: usize,
    nv12_binding: &'static str,
}

#[derive(Serialize)]
struct WitnessReport {
    schema_version: u32,
    status: &'static str,
    scope: &'static str,
    project_authored_sha256: String,
    project_runtime_sha256: String,
    adapter: aster_render::AdapterDiagnostics,
    video: aster_render_ir::ExportVideoConfig,
    output: PathBuf,
    output_sha256: String,
    frame_count: u64,
    transport: &'static str,
    frames: Vec<WitnessFrame>,
}

#[derive(Serialize)]
pub(crate) struct WitnessReceipt {
    path: PathBuf,
    report_sha256: String,
    frames: usize,
}

impl ExportWitness {
    pub fn new(
        destination: &Path,
        selected: Vec<u64>,
        count: u64,
        budget: u64,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let unique: BTreeSet<_> = selected.iter().copied().collect();
        if unique.is_empty()
            || unique.len() != selected.len()
            || unique.len() > 4096
            || unique.iter().any(|index| *index >= count)
        {
            return Err(
                "witness frames must be unique, bounded and inside the export schedule".into(),
            );
        }
        Ok(Self {
            capture: ProjectCapture::new(destination, budget)?,
            destination: std::path::absolute(destination)?,
            selected: unique,
            frames: Vec::new(),
        })
    }

    pub fn finish(
        mut self,
        export: &aster_render_project::ProjectExportReport,
        project: &crate::project_runtime::ProjectIdentity,
        video: &aster_render_ir::ExportVideoConfig,
        adapter: &aster_render::AdapterDiagnostics,
    ) -> Result<WitnessReceipt, Box<dyn std::error::Error>> {
        if self
            .frames
            .iter()
            .map(|frame| frame.index)
            .collect::<BTreeSet<_>>()
            != self.selected
        {
            return Err("export witness is missing selected frames".into());
        }
        let mut file = std::fs::File::open(&export.output)?;
        let mut buffer = [0_u8; 65_536];
        let mut digest = Sha256::new();
        let mut bytes = 0_u64;
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            digest.update(&buffer[..count]);
            bytes += count as u64;
        }
        if bytes != export.output_bytes {
            return Err("export size changed before witness publication".into());
        }
        let frames = self.frames.len();
        let report = WitnessReport {
            schema_version: 1,
            status: "captured",
            scope: "Actual native export frames before hardware encoding; no pixel or quality verdict",
            project_authored_sha256: project.authored_sha256.clone(),
            project_runtime_sha256: project.runtime_sha256.clone(),
            adapter: adapter.clone(),
            video: video.clone(),
            output: export.output.clone(),
            output_sha256: format!("{:x}", digest.finalize()),
            frame_count: export.frames,
            transport: export.transport,
            frames: self.frames,
        };
        let report = serde_json::to_vec(&report)?;
        let receipt = WitnessReceipt {
            path: self.destination.join("report.json"),
            report_sha256: format!("{:x}", Sha256::digest(&report)),
            frames,
        };
        self.capture.write(Path::new("report.json"), &report)?;
        self.capture.finish()?;
        Ok(receipt)
    }
}

impl ProjectExportObserver for ExportWitness {
    fn observe(
        &mut self,
        index: u64,
        request: &FramePlanRequest,
        prepared: &PreparedProjectFrame,
        rendered: &RenderedFrame,
        renderer: &mut NativeRenderer,
        encoder_input: Option<&[u8]>,
    ) -> Result<(), ProjectRenderError> {
        if !self.selected.contains(&index) {
            return Ok(());
        }
        if self.frames.last().is_some_and(|frame| frame.index >= index) {
            return Err(ProjectRenderError::Invalid(
                "export witness order differs".into(),
            ));
        }
        let image = RgbaImage {
            width: rendered.size.width,
            height: rendered.size.height,
            pixels: renderer.read_rgba(rendered)?,
        };
        let mirror;
        let (nv12, binding) = match encoder_input {
            Some(input) => (input, "exact-encoder-memory-input"),
            None => {
                mirror = renderer.read_nv12(rendered)?;
                (mirror.as_slice(), "same-frame-shared-conversion-mirror")
            }
        };
        let rgb = self
            .capture
            .frame(index as usize, prepared, &image)
            .map_err(|error| ProjectRenderError::Invalid(error.to_string()))?;
        self.capture
            .write(&PathBuf::from(index.to_string()).join("input.nv12"), nv12)
            .map_err(|error| ProjectRenderError::Invalid(error.to_string()))?;
        self.frames.push(WitnessFrame {
            index,
            composition: request.composition_id.clone(),
            time: request.time,
            time_bits: format!("{:016x}", request.time.to_bits()),
            snapshot_scope: request.snapshot_scope.clone(),
            project_revision: request.project_revision,
            rgb,
            nv12_sha256: format!("{:x}", Sha256::digest(nv12)),
            nv12_bytes: nv12.len(),
            nv12_binding: binding,
        });
        Ok(())
    }
}

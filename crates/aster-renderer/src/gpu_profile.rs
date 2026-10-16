use std::{cell::RefCell, sync::mpsc, time::Duration};

use serde::Serialize;

use crate::RenderError;

/// Diagnostic GPU execution intervals, excluding CPU preparation and command submission.
#[derive(Clone, Debug, Default, Serialize)]
pub struct GpuTimings {
    pub temporal_ms: f64,
    pub surfaces_ms: f64,
    pub scene_ms: f64,
    pub output_ms: f64,
    pub nv12_conversion_ms: f64,
    pub nv12_copy_ms: f64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub scene_passes: Vec<SceneGpuTiming>,
    pub scene_passes_omitted: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct SceneGpuTiming {
    pub command_index: usize,
    pub effect_blob_index: Option<u32>,
    pub kind: String,
    pub elapsed_ms: f64,
}

impl GpuTimings {
    pub fn accumulate(&mut self, frame: Self) {
        self.temporal_ms += frame.temporal_ms;
        self.surfaces_ms += frame.surfaces_ms;
        self.scene_ms += frame.scene_ms;
        self.output_ms += frame.output_ms;
        self.nv12_conversion_ms += frame.nv12_conversion_ms;
        self.nv12_copy_ms += frame.nv12_copy_ms;
    }
}

pub(crate) struct GpuProfiler {
    queries: wgpu::QuerySet,
    resolved: wgpu::Buffer,
    staging: wgpu::Buffer,
    period_ns: f64,
    scene_passes: RefCell<Vec<SceneGpuTiming>>,
    omitted: std::cell::Cell<usize>,
}

impl GpuProfiler {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        Self {
            queries: device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("Native diagnostic GPU timestamps"),
                ty: wgpu::QueryType::Timestamp,
                count: 133,
            }),
            resolved: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Resolved diagnostic timestamps"),
                size: 1088,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }),
            staging: device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Diagnostic timestamp readback"),
                size: 1088,
                usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                mapped_at_creation: false,
            }),
            period_ns: f64::from(queue.get_timestamp_period()),
            scene_passes: RefCell::new(Vec::new()),
            omitted: std::cell::Cell::new(0),
        }
    }

    pub fn reset_frame(&self) {
        self.scene_passes.borrow_mut().clear();
        self.omitted.set(0);
    }

    pub fn begin_scene_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        command_index: usize,
        command: &aster_render_ir::RootCommandRecord,
    ) -> Option<u32> {
        let mut passes = self.scene_passes.borrow_mut();
        if passes.len() == 64 {
            self.omitted.set(self.omitted.get() + 1);
            return None;
        }
        let (kind, effect_blob_index) = match command {
            aster_render_ir::RootCommandRecord::BeginLayer { effect_blob_index } => {
                ("layer", Some(*effect_blob_index))
            }
            aster_render_ir::RootCommandRecord::Adjustment { effect_blob_index } => {
                ("adjustment", Some(*effect_blob_index))
            }
            _ => ("scene", None),
        };
        let slot = 5 + passes.len() as u32 * 2;
        passes.push(SceneGpuTiming {
            command_index,
            effect_blob_index,
            kind: kind.into(),
            elapsed_ms: 0.0,
        });
        self.mark(encoder, slot);
        Some(slot)
    }

    pub fn end_scene_pass(&self, encoder: &mut wgpu::CommandEncoder, slot: Option<u32>) {
        if let Some(slot) = slot {
            self.mark(encoder, slot + 1);
        }
    }

    pub fn resolve_frame(&self, encoder: &mut wgpu::CommandEncoder) {
        let count = 5 + self.scene_passes.borrow().len() as u32 * 2;
        self.resolve(encoder, count);
    }

    pub fn read_frame(
        &self,
        device: &wgpu::Device,
        timeout: Duration,
    ) -> Result<GpuTimings, RenderError> {
        let mut passes = self.scene_passes.borrow().clone();
        let ticks = self.read_ticks(device, timeout, 5 + passes.len() * 2)?;
        let mut intervals = Vec::with_capacity(4 + passes.len());
        for (start, end) in (0..4)
            .map(|index| (index, index + 1))
            .chain((0..passes.len()).map(|index| (5 + index * 2, 6 + index * 2)))
        {
            let delta = ticks[end]
                .checked_sub(ticks[start])
                .ok_or_else(|| RenderError::Gpu("GPU timestamps are not monotonic".into()))?;
            intervals.push(delta as f64 * self.period_ns / 1_000_000.0);
        }
        for (pass, elapsed) in passes.iter_mut().zip(&intervals[4..]) {
            pass.elapsed_ms = *elapsed;
        }
        Ok(GpuTimings {
            temporal_ms: intervals[0],
            surfaces_ms: intervals[1],
            scene_ms: intervals[2],
            output_ms: intervals[3],
            scene_passes: passes,
            scene_passes_omitted: self.omitted.get(),
            ..Default::default()
        })
    }

    pub fn mark(&self, encoder: &mut wgpu::CommandEncoder, index: u32) {
        encoder.write_timestamp(&self.queries, index);
    }

    pub fn resolve(&self, encoder: &mut wgpu::CommandEncoder, count: u32) {
        encoder.resolve_query_set(&self.queries, 0..count, &self.resolved, 0);
        encoder.copy_buffer_to_buffer(&self.resolved, 0, &self.staging, 0, u64::from(count) * 8);
    }

    pub fn read(
        &self,
        device: &wgpu::Device,
        timeout: Duration,
        count: usize,
    ) -> Result<Vec<f64>, RenderError> {
        self.read_ticks(device, timeout, count)?
            .windows(2)
            .map(|pair| {
                pair[1]
                    .checked_sub(pair[0])
                    .map(|ticks| ticks as f64 * self.period_ns / 1_000_000.0)
                    .ok_or_else(|| RenderError::Gpu("GPU timestamps are not monotonic".into()))
            })
            .collect()
    }

    fn read_ticks(
        &self,
        device: &wgpu::Device,
        timeout: Duration,
        count: usize,
    ) -> Result<Vec<u64>, RenderError> {
        if !(2..=133).contains(&count) || !self.period_ns.is_finite() || self.period_ns <= 0.0 {
            return Err(RenderError::Invalid(
                "invalid GPU timestamp dimensions or period".into(),
            ));
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        self.staging
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |result| {
                let _ = sender.send(result);
            });
        let result = (|| {
            device
                .poll(wgpu::PollType::Wait {
                    submission_index: None,
                    timeout: Some(timeout),
                })
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            receiver
                .recv_timeout(timeout)
                .map_err(|error| RenderError::Gpu(error.to_string()))?
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            let mapped = self
                .staging
                .slice(..)
                .get_mapped_range()
                .map_err(|error| RenderError::Gpu(error.to_string()))?;
            mapped[..count * 8]
                .chunks_exact(8)
                .map(|bytes| {
                    <[u8; 8]>::try_from(bytes)
                        .map(u64::from_le_bytes)
                        .map_err(|error| RenderError::Gpu(error.to_string()))
                })
                .collect::<Result<Vec<_>, _>>()
        })();
        self.staging.unmap();
        result
    }
}

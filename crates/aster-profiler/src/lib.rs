//! Lightweight CPU/GPU frame metrics designed to stay enabled in editor builds.

mod benchmark;

pub use benchmark::{
    BenchmarkEnvironment, BenchmarkRecorder, BenchmarkReport, BenchmarkStatistics, Distribution,
    Regression, RegressionPolicy,
};

use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default)]
pub struct Profiler {
    samples: Arc<Mutex<Vec<ScopeSample>>>,
}

impl Profiler {
    pub fn scope(&self, name: impl Into<String>) -> ScopeGuard {
        ScopeGuard {
            name: name.into(),
            started: Instant::now(),
            samples: Arc::clone(&self.samples),
        }
    }

    pub fn take_samples(&self) -> Vec<ScopeSample> {
        std::mem::take(&mut *self.samples.lock())
    }
}

pub struct ScopeGuard {
    name: String,
    started: Instant,
    samples: Arc<Mutex<Vec<ScopeSample>>>,
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        self.samples.lock().push(ScopeSample {
            name: self.name.clone(),
            duration: self.started.elapsed(),
        });
    }
}

#[derive(Clone, Debug)]
pub struct ScopeSample {
    pub name: String,
    pub duration: Duration,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct FrameMetrics {
    pub cpu_ms: f32,
    pub gpu_ms: f32,
    pub frame_ms: f32,
    pub vram_bytes: u64,
    pub draw_calls: u32,
    pub dispatches: u32,
    pub dirty_nodes: u32,
    pub cache_hit_rate: f32,
}

#[derive(Clone, Debug)]
pub struct FrameHistory {
    capacity: usize,
    frames: VecDeque<FrameMetrics>,
}

impl FrameHistory {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity: capacity.max(1),
            frames: VecDeque::with_capacity(capacity.max(1)),
        }
    }

    pub fn push(&mut self, metrics: FrameMetrics) {
        if self.frames.len() == self.capacity {
            self.frames.pop_front();
        }
        self.frames.push_back(metrics);
    }

    pub fn average(&self) -> FrameMetrics {
        if self.frames.is_empty() {
            return FrameMetrics::default();
        }
        let mut result = FrameMetrics::default();
        for frame in &self.frames {
            result.cpu_ms += frame.cpu_ms;
            result.gpu_ms += frame.gpu_ms;
            result.frame_ms += frame.frame_ms;
            result.vram_bytes += frame.vram_bytes;
            result.draw_calls += frame.draw_calls;
            result.dispatches += frame.dispatches;
            result.dirty_nodes += frame.dirty_nodes;
            result.cache_hit_rate += frame.cache_hit_rate;
        }
        let count = self.frames.len() as f32;
        result.cpu_ms /= count;
        result.gpu_ms /= count;
        result.frame_ms /= count;
        result.vram_bytes /= self.frames.len() as u64;
        result.draw_calls /= self.frames.len() as u32;
        result.dispatches /= self.frames.len() as u32;
        result.dirty_nodes /= self.frames.len() as u32;
        result.cache_hit_rate /= count;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_average_obeys_capacity() {
        let mut history = FrameHistory::new(2);
        history.push(FrameMetrics {
            frame_ms: 30.0,
            ..FrameMetrics::default()
        });
        history.push(FrameMetrics {
            frame_ms: 20.0,
            ..FrameMetrics::default()
        });
        history.push(FrameMetrics {
            frame_ms: 10.0,
            ..FrameMetrics::default()
        });
        assert_eq!(history.average().frame_ms, 15.0);
    }
}

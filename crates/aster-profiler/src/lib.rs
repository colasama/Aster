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
        let count = self.frames.len() as u128;
        let mut integer_totals = [0_u128; 4];
        let mut float_totals = [0_f64; 4];
        for frame in &self.frames {
            for (total, value) in integer_totals.iter_mut().zip([
                u128::from(frame.vram_bytes),
                u128::from(frame.draw_calls),
                u128::from(frame.dispatches),
                u128::from(frame.dirty_nodes),
            ]) {
                *total += value;
            }
            for (total, value) in float_totals.iter_mut().zip([
                frame.cpu_ms,
                frame.gpu_ms,
                frame.frame_ms,
                frame.cache_hit_rate,
            ]) {
                *total += f64::from(value);
            }
        }
        FrameMetrics {
            cpu_ms: (float_totals[0] / count as f64) as f32,
            gpu_ms: (float_totals[1] / count as f64) as f32,
            frame_ms: (float_totals[2] / count as f64) as f32,
            cache_hit_rate: (float_totals[3] / count as f64) as f32,
            vram_bytes: (integer_totals[0] / count) as u64,
            draw_calls: (integer_totals[1] / count) as u32,
            dispatches: (integer_totals[2] / count) as u32,
            dirty_nodes: (integer_totals[3] / count) as u32,
        }
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
    #[test]
    fn averaging_large_samples_does_not_overflow() {
        let mut history = FrameHistory::new(2);
        let metrics = FrameMetrics {
            frame_ms: f32::MAX,
            vram_bytes: u64::MAX,
            draw_calls: u32::MAX,
            ..FrameMetrics::default()
        };
        history.push(metrics);
        history.push(metrics);
        let average = history.average();
        assert_eq!(average.vram_bytes, u64::MAX);
        assert_eq!(average.draw_calls, u32::MAX);
        assert_eq!(average.frame_ms, f32::MAX);
    }
}

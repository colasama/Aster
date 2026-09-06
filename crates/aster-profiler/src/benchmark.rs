use serde::{Deserialize, Serialize};

use crate::FrameMetrics;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BenchmarkEnvironment {
    pub commit: String,
    pub operating_system: String,
    pub architecture: String,
    pub adapter: String,
    pub backend: String,
    pub width: u32,
    pub height: u32,
    pub preview_quality: String,
}

impl BenchmarkEnvironment {
    pub fn current(adapter: impl Into<String>, backend: impl Into<String>) -> Self {
        Self {
            commit: std::env::var("GITHUB_SHA").unwrap_or_else(|_| "local".to_owned()),
            operating_system: std::env::consts::OS.to_owned(),
            architecture: std::env::consts::ARCH.to_owned(),
            adapter: adapter.into(),
            backend: backend.into(),
            width: 0,
            height: 0,
            preview_quality: "n/a".to_owned(),
        }
    }

    pub fn with_resolution(mut self, width: u32, height: u32, quality: impl Into<String>) -> Self {
        self.width = width;
        self.height = height;
        self.preview_quality = quality.into();
        self
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct Distribution {
    pub minimum: f64,
    pub median: f64,
    pub p95: f64,
    pub p99: f64,
    pub maximum: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BenchmarkStatistics {
    pub cpu_ms: Distribution,
    pub gpu_ms: Distribution,
    pub frame_ms: Distribution,
    pub frames_per_second: Distribution,
    pub estimated_vram_mb: Distribution,
    pub draw_calls: Distribution,
    pub dispatches: Distribution,
    pub dirty_nodes: Distribution,
    pub cache_hit_rate: Distribution,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BenchmarkReport {
    pub schema_version: u32,
    pub suite: String,
    pub scenario: String,
    pub warmup_frames: usize,
    pub sample_frames: usize,
    pub environment: BenchmarkEnvironment,
    pub statistics: BenchmarkStatistics,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct RegressionPolicy {
    pub median_percent: f64,
    pub p95_percent: f64,
}

impl Default for RegressionPolicy {
    fn default() -> Self {
        Self {
            median_percent: 5.0,
            p95_percent: 10.0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Regression {
    pub metric: String,
    pub median_change_percent: f64,
    pub p95_change_percent: f64,
}

impl BenchmarkReport {
    pub fn regressions_against(
        &self,
        baseline: &Self,
        policy: RegressionPolicy,
    ) -> Vec<Regression> {
        [
            ("cpu_ms", self.statistics.cpu_ms, baseline.statistics.cpu_ms),
            ("gpu_ms", self.statistics.gpu_ms, baseline.statistics.gpu_ms),
            (
                "frame_ms",
                self.statistics.frame_ms,
                baseline.statistics.frame_ms,
            ),
        ]
        .into_iter()
        .filter_map(|(metric, current, previous)| {
            let median = Regression::percent_change(current.median, previous.median);
            let p95 = Regression::percent_change(current.p95, previous.p95);
            (median > policy.median_percent || p95 > policy.p95_percent).then(|| Regression {
                metric: metric.to_owned(),
                median_change_percent: median,
                p95_change_percent: p95,
            })
        })
        .collect()
    }
}

#[derive(Clone, Debug)]
pub struct BenchmarkRecorder {
    warmup_frames: usize,
    observed_frames: usize,
    samples: Vec<FrameMetrics>,
}

impl BenchmarkRecorder {
    pub fn new(warmup_frames: usize) -> Self {
        Self {
            warmup_frames,
            observed_frames: 0,
            samples: Vec::new(),
        }
    }

    pub fn record(&mut self, metrics: FrameMetrics) {
        self.observed_frames += 1;
        if self.observed_frames > self.warmup_frames {
            self.samples.push(metrics);
        }
    }

    pub fn finish(
        self,
        suite: impl Into<String>,
        scenario: impl Into<String>,
        environment: BenchmarkEnvironment,
    ) -> Option<BenchmarkReport> {
        if self.samples.is_empty() {
            return None;
        }
        let statistics = BenchmarkStatistics::from_frames(&self.samples);
        Some(BenchmarkReport {
            schema_version: 1,
            suite: suite.into(),
            scenario: scenario.into(),
            warmup_frames: self.warmup_frames,
            sample_frames: self.samples.len(),
            environment,
            statistics,
        })
    }
}

impl BenchmarkStatistics {
    fn from_frames(frames: &[FrameMetrics]) -> Self {
        Self {
            cpu_ms: Distribution::from_values(frames.iter().map(|frame| f64::from(frame.cpu_ms))),
            gpu_ms: Distribution::from_values(frames.iter().map(|frame| f64::from(frame.gpu_ms))),
            frame_ms: Distribution::from_values(
                frames.iter().map(|frame| f64::from(frame.frame_ms)),
            ),
            frames_per_second: Distribution::from_values(frames.iter().map(|frame| {
                if frame.frame_ms > 0.0 {
                    1_000.0 / f64::from(frame.frame_ms)
                } else {
                    0.0
                }
            })),
            estimated_vram_mb: Distribution::from_values(
                frames
                    .iter()
                    .map(|frame| frame.vram_bytes as f64 / (1024.0 * 1024.0)),
            ),
            draw_calls: Distribution::from_values(
                frames.iter().map(|frame| f64::from(frame.draw_calls)),
            ),
            dispatches: Distribution::from_values(
                frames.iter().map(|frame| f64::from(frame.dispatches)),
            ),
            dirty_nodes: Distribution::from_values(
                frames.iter().map(|frame| f64::from(frame.dirty_nodes)),
            ),
            cache_hit_rate: Distribution::from_values(
                frames.iter().map(|frame| f64::from(frame.cache_hit_rate)),
            ),
        }
    }
}

impl Distribution {
    fn from_values(values: impl Iterator<Item = f64>) -> Distribution {
        let mut values: Vec<_> = values.filter(|value| value.is_finite()).collect();
        if values.is_empty() {
            return Distribution::default();
        }
        values.sort_by(f64::total_cmp);
        Distribution {
            minimum: values[0],
            median: Self::percentile(&values, 0.5),
            p95: Self::percentile(&values, 0.95),
            p99: Self::percentile(&values, 0.99),
            maximum: values[values.len() - 1],
        }
    }

    fn percentile(values: &[f64], percentile: f64) -> f64 {
        let position = percentile.clamp(0.0, 1.0) * (values.len() - 1) as f64;
        let lower = position.floor() as usize;
        let upper = position.ceil() as usize;
        let weight = position - lower as f64;
        values[lower] * (1.0 - weight) + values[upper] * weight
    }
}

impl Regression {
    fn percent_change(current: f64, baseline: f64) -> f64 {
        if baseline <= f64::EPSILON {
            return 0.0;
        }
        (current - baseline) / baseline * 100.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discards_warmup_and_reports_interpolated_percentiles() -> Result<(), &'static str> {
        let mut recorder = BenchmarkRecorder::new(1);
        for frame_ms in [100.0, 10.0, 20.0, 30.0, 40.0] {
            recorder.record(FrameMetrics {
                frame_ms,
                cpu_ms: frame_ms / 2.0,
                ..FrameMetrics::default()
            });
        }
        let report = recorder
            .finish(
                "test",
                "distribution",
                BenchmarkEnvironment::current("test", "cpu"),
            )
            .ok_or("post-warmup samples")?;
        assert_eq!(report.sample_frames, 4);
        assert_eq!(report.statistics.frame_ms.minimum, 10.0);
        assert_eq!(report.statistics.frame_ms.median, 25.0);
        assert_eq!(report.statistics.frame_ms.p95, 38.5);
        assert_eq!(report.statistics.frame_ms.maximum, 40.0);
        Ok(())
    }

    #[test]
    fn requires_at_least_one_measured_frame() {
        assert!(
            BenchmarkRecorder::new(2)
                .finish(
                    "test",
                    "empty",
                    BenchmarkEnvironment::current("test", "cpu")
                )
                .is_none()
        );
    }

    #[test]
    fn detects_median_and_tail_regressions() {
        let baseline = BenchmarkReport::with_times(10.0, 12.0);
        let current = BenchmarkReport::with_times(10.6, 13.3);
        let regressions = current.regressions_against(&baseline, RegressionPolicy::default());
        assert_eq!(regressions.len(), 3);
        assert_eq!(regressions[0].metric, "cpu_ms");
        assert!(regressions[0].median_change_percent > 5.0);
        assert!(regressions[0].p95_change_percent > 10.0);
    }

    impl BenchmarkReport {
        fn with_times(median: f64, p95: f64) -> BenchmarkReport {
            let timing = Distribution {
                median,
                p95,
                ..Distribution::default()
            };
            BenchmarkReport {
                schema_version: 1,
                suite: "test".to_owned(),
                scenario: "regression".to_owned(),
                warmup_frames: 0,
                sample_frames: 1,
                environment: BenchmarkEnvironment::current("test", "cpu"),
                statistics: BenchmarkStatistics {
                    cpu_ms: timing,
                    gpu_ms: timing,
                    frame_ms: timing,
                    ..BenchmarkStatistics::default()
                },
            }
        }
    }
}

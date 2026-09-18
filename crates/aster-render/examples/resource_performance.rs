use std::{hint::black_box, time::Instant};

use aster_render::{PassKind, RenderGraph, ResourceDescriptor, ResourcePool, TextureFormat};
use clap::Parser;
use serde::Serialize;

#[derive(Parser, Serialize)]
struct ResourceBenchmark {
    #[arg(long, default_value_t = 2048, value_parser = clap::value_parser!(u32).range(1..))]
    resources: u32,
    #[arg(long, default_value_t = 20)]
    warmup: u32,
    #[arg(long, default_value_t = 600, value_parser = clap::value_parser!(u32).range(1..))]
    samples: u32,
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..))]
    pool_operations: u32,
}

#[derive(Serialize)]
struct Measurement {
    scenario: &'static str,
    median_ns: f64,
    p95_ns: f64,
    samples_ns: Vec<f64>,
}

impl Measurement {
    fn record(scenario: &'static str, samples_ns: Vec<f64>) -> Self {
        let mut sorted = samples_ns.clone();
        sorted.sort_by(f64::total_cmp);
        Self {
            scenario,
            median_ns: sorted[sorted.len() / 2],
            p95_ns: sorted[(sorted.len() * 95).div_ceil(100) - 1],
            samples_ns,
        }
    }
}

#[derive(Serialize)]
struct Report {
    options: ResourceBenchmark,
    operating_system: &'static str,
    architecture: &'static str,
    measurements: Vec<Measurement>,
}

impl ResourceBenchmark {
    fn run(&self) -> Result<Vec<Measurement>, Box<dyn std::error::Error>> {
        let descriptor = ResourceDescriptor {
            width: 1920,
            height: 1080,
            format: TextureFormat::Rgba16Float,
            samples: 1,
            transient: true,
        };
        let mut graph = RenderGraph::default();
        let handles: Vec<_> = (0..self.resources)
            .map(|_| graph.create_resource(descriptor))
            .collect();
        graph.add_pass(
            "overlapping resources",
            PassKind::Compute,
            vec![],
            handles,
            vec![],
        );
        let mut pool = ResourcePool::new(u64::MAX);
        let handles: Vec<_> = (0..self.resources)
            .map(|_| pool.acquire_with(descriptor, |_| ()))
            .collect();
        for handle in handles {
            assert!(pool.release(handle));
        }

        let mut compile_samples = Vec::new();
        let mut pool_samples = Vec::new();
        for frame in 0..u64::from(self.warmup) + u64::from(self.samples) {
            let started = Instant::now();
            let compiled = graph.compile()?;
            black_box(&compiled);
            let elapsed = started.elapsed().as_secs_f64() * 1e9;
            assert_eq!(compiled.allocations.len(), self.resources as usize);
            assert_eq!(
                compiled.estimated_vram_bytes,
                descriptor.estimated_bytes() * u64::from(self.resources)
            );
            if frame >= u64::from(self.warmup) {
                compile_samples.push(elapsed);
            }

            let started = Instant::now();
            for _ in 0..self.pool_operations {
                let handle = pool.acquire_with(black_box(descriptor), |_| ());
                black_box(pool.release(handle));
                black_box(pool.statistics());
            }
            let elapsed = started.elapsed().as_secs_f64() * 1e9 / f64::from(self.pool_operations);
            if frame >= u64::from(self.warmup) {
                pool_samples.push(elapsed);
            }
        }
        assert_eq!(pool.statistics().evictions, 0);
        assert_eq!(pool.statistics().cached_resources, self.resources as usize);
        Ok(vec![
            Measurement::record("compile overlapping transient resources", compile_samples),
            Measurement::record(
                "pool acquire/release/statistics per operation",
                pool_samples,
            ),
        ])
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = ResourceBenchmark::parse();
    let measurements = options.run()?;
    let report = Report {
        options,
        operating_system: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        measurements,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

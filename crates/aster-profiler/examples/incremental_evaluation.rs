use std::{hint::black_box, time::Instant};

use aster_core::{DependencyGraph, NodeId};
use aster_profiler::{BenchmarkEnvironment, BenchmarkRecorder, BenchmarkReport, FrameMetrics};

#[derive(clap::Parser)]
struct EvaluationBenchmark {
    #[arg(long, default_value_t = 10_000, value_parser = clap::value_parser!(u32).range(1..))]
    node_count: u32,
    #[arg(long, default_value_t = 20)]
    warmup_frames: u32,
    #[arg(long, default_value_t = 600, value_parser = clap::value_parser!(u32).range(1..))]
    sample_frames: u32,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    use clap::Parser;
    let benchmark = EvaluationBenchmark::parse();
    let reports = benchmark.run()?;
    println!("{}", serde_json::to_string_pretty(&reports)?);
    Ok(())
}

impl EvaluationBenchmark {
    fn run(&self) -> Result<Vec<BenchmarkReport>, Box<dyn std::error::Error>> {
        let nodes: Vec<_> = (0..self.node_count).map(|_| NodeId::new_v4()).collect();
        let mut graph = DependencyGraph::default();
        for node in &nodes {
            graph.add_node(*node);
        }
        for pair in nodes.windows(2) {
            graph.add_dependency(pair[1], pair[0])?;
        }
        let environment = BenchmarkEnvironment::current("CPU dependency DAG", "rust");
        Ok(vec![
            self.run_scenario(
                &mut graph,
                nodes[0],
                "full-graph invalidation",
                environment.clone(),
            )?,
            self.run_scenario(
                &mut graph,
                nodes[nodes.len() - 1],
                "leaf-node incremental invalidation",
                environment,
            )?,
        ])
    }

    fn run_scenario(
        &self,
        graph: &mut DependencyGraph,
        root: NodeId,
        scenario: &str,
        environment: BenchmarkEnvironment,
    ) -> Result<BenchmarkReport, Box<dyn std::error::Error>> {
        let mut recorder = BenchmarkRecorder::new(self.warmup_frames as usize);
        for _ in 0..(u64::from(self.warmup_frames) + u64::from(self.sample_frames)) {
            let started = Instant::now();
            let dirty = graph.mark_dirty(root);
            let order = graph.take_evaluation_order()?;
            black_box(order.len());
            let elapsed_ms = started.elapsed().as_secs_f32() * 1_000.0;
            recorder.record(FrameMetrics {
                cpu_ms: elapsed_ms,
                frame_ms: elapsed_ms,
                dirty_nodes: dirty.dirty_nodes as u32,
                cache_hit_rate: 1.0 - dirty.dirty_nodes as f32 / dirty.total_nodes as f32,
                ..FrameMetrics::default()
            });
        }
        recorder
            .finish("10k-node incremental evaluation", scenario, environment)
            .ok_or_else(|| "benchmark did not record measured samples".into())
    }
}

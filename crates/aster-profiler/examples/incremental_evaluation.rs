use std::{hint::black_box, time::Instant};

use aster_core::{DependencyGraph, NodeId};
use aster_profiler::{BenchmarkEnvironment, BenchmarkRecorder, BenchmarkReport, FrameMetrics};

const NODE_COUNT: usize = 10_000;
const WARMUP_FRAMES: usize = 20;
const SAMPLE_FRAMES: usize = 600;

fn main() {
    let (mut graph, nodes) = build_graph();
    let environment = BenchmarkEnvironment::current("CPU dependency DAG", "rust");
    let reports = vec![
        run_scenario(
            &mut graph,
            nodes[0],
            "full-graph invalidation",
            environment.clone(),
        ),
        run_scenario(
            &mut graph,
            nodes[NODE_COUNT - 1],
            "leaf-node incremental invalidation",
            environment,
        ),
    ];
    println!(
        "{}",
        serde_json::to_string_pretty(&reports).expect("serialize benchmark report")
    );
}

fn build_graph() -> (DependencyGraph, Vec<NodeId>) {
    let nodes: Vec<_> = (0..NODE_COUNT).map(|_| NodeId::new_v4()).collect();
    let mut graph = DependencyGraph::default();
    for pair in nodes.windows(2) {
        graph
            .add_dependency(pair[1], pair[0])
            .expect("linear dependency graph is acyclic");
    }
    (graph, nodes)
}

fn run_scenario(
    graph: &mut DependencyGraph,
    root: NodeId,
    scenario: &str,
    environment: BenchmarkEnvironment,
) -> BenchmarkReport {
    let mut recorder = BenchmarkRecorder::new(WARMUP_FRAMES);
    for _ in 0..(WARMUP_FRAMES + SAMPLE_FRAMES) {
        let started = Instant::now();
        let dirty = graph.mark_dirty(root);
        let order = graph
            .take_evaluation_order()
            .expect("benchmark graph remains valid");
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
        .expect("benchmark records measured samples")
}

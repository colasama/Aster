# Benchmark methodology

Measure release builds after pipeline warm-up on AC power with the same project seed, resolution,
preview quality, driver, and adapter. Record median, p95, and p99 over at least 600 frames.

## Suites

- 1080p and 4K 20-layer 2D composite.
- Large-radius blur, glow, and mixed effect chains.
- 100,000 and 1,000,000 compute particles.
- 3D scene with PBR lights and auxiliary buffers.
- Hardware decode, seek, frame upload, full-resolution export, and sustained PNG sequence export.

Report CPU submit time, GPU frame/pass time, FPS, draw/dispatch counts, upload bytes, transient texture
count, peak estimated VRAM, cache hit rate, and shader/pipeline compilation events. Commit machine-
readable JSON baselines; a regression is more than 5% median or 10% p95 unless the change documents an
intentional quality tradeoff.

For sequence export, also report frames per second, median GPU render time, median PNG encode/write
time, peak resident memory, and cancellation latency. Use at least 300 frames and a pre-selected local
SSD output directory so the directory picker is outside the measured interval.

## Incremental evaluation benchmark

Run the release-mode 10,000-node dependency benchmark with:

```shell
cargo run -p aster-profiler --release --example incremental_evaluation
```

It discards 20 warm-up iterations and emits two 600-frame JSON reports: full-graph invalidation and
single-leaf invalidation. Reports use schema version 1 and include environment metadata plus min,
median, p95, p99, and max distributions. `BenchmarkReport::regressions_against` applies the project
policy of 5% median and 10% p95 timing thresholds. Nightly CI stores the generated JSON as a build
artifact so results remain attributable to the exact commit and runner.

On the Windows x86-64 development machine used for the initial implementation, the 10,000-node
full invalidation measured 1.008 ms median / 1.234 ms p95; a leaf-only invalidation measured 0.069 ms
median / 0.071 ms p95, with 99.99% of nodes retained. These numbers are reference observations, not
portable pass/fail limits.

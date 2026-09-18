# Benchmark methodology

Measure release builds after pipeline warm-up on AC power with the same project seed, resolution,
preview quality, driver, and adapter. Record median, p95, and p99 over at least 600 frames.

The fixed primary MVP machine is described by the privacy-safe, machine-readable
[`windows-rtx5060-laptop.json`](../benchmarks/hardware/windows-rtx5060-laptop.json) manifest. A result
must cite that exact manifest and satisfy its run conditions; a changed driver, OS build, display
topology, power mode, or selected adapter starts a separate baseline series. Hardware capture and
adapter-verification steps are documented in [`benchmarks/hardware`](../benchmarks/hardware).

Development startup is measured separately from release performance. On the same Windows checkout,
capture Vite's `vite:time` log from the first `index.html` request through the renderer's
`renderer_started` event, with caches left in their normal development state. On 2026-08-30, the
request-by-request server spent about 10.1 seconds serving the entry stage and 13.8 seconds expanding
the editor graph, with renderer mount about 28 seconds after the desktop bridge became ready. Vite 8
full-bundle development mode served `index.html` in 1.7 ms and the generated editor bundle in 17 ms;
the renderer mounted in under 0.3 seconds and the warmed WebGPU renderer became ready in about one
second. These are local diagnostic observations, not release baselines or cross-machine targets.
Record the `ASTER_BUNDLED_DEV` setting with startup diagnostics; set it to `0` only when deliberately
reproducing the request-by-request baseline.

Any public comparison with another application follows the preregistered
[`competitor-comparison-v1.md`](../benchmarks/protocols/competitor-comparison-v1.md) protocol. It
requires equivalent visible output and quality, rotating application order, three raw runs, declared
metric sources, published fixtures and raw data, and explicit unsupported results. It forbids
substituting an easier workload or using unmatched timing sources in one performance ratio.

## Suites

- 1080p and 4K 20-layer 2D composite.
- Large-radius blur, glow, and mixed effect chains. For alpha-based layer styles,
  compare thin text at 1080p and 4K across radius 4/24/128, record median/p95 GPU
  time and texture allocation, and check transparent margins and glyph coverage.
  Benchmark normal, multiply and overlay separately: backdrop-dependent modes add
  a GPU copy/composite while reusing the effect textures. Correctness checks and
  bounded-kernel limitations are documented in [LAYER_STYLES.md](LAYER_STYLES.md).
- 100,000, 500,000, and 1,000,000 instances through the bundled particle Scene Generator plugin.
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

On the Windows x86-64 development machine used for the initial implementation, the 10,000-node full
invalidation measured 1.008 ms median / 1.234 ms p95; a leaf-only invalidation measured 0.069 ms
median / 0.071 ms p95, with 99.99% of nodes retained. These numbers predate the fixed-manifest policy:
they are reference observations, not a manifest-qualified baseline or portable pass/fail limits.

## Native resource management microbenchmark

Run `cargo run --release -p aster-render --example resource_performance` to measure graph compilation
with 2,048 simultaneously live transient resources and warmed pool acquire/release/statistics.
The example discards 20 warm-up samples and records 600 samples, including raw nanosecond timings,
median and nearest-rank p95. Pool samples average 100 operations to reduce timer quantization.
Use `--resources`, `--warmup`, `--samples`, and `--pool-operations` to vary the workload. Graph and
pool setup and graph destruction are outside the timed regions. Payloads are `()`: no GPU textures
are allocated, and the memory figures are descriptor estimates rather than measured VRAM.

Build both revisions with the identical example and release profile, then alternate the standalone
executables for at least three runs per revision without concurrent builds. Record revision,
toolchain, CPU, OS and options beside the raw JSON. These CPU diagnostics do not measure GPU frame
time or editor FPS and are not manifest-qualified release baselines. See the
[2026-09-12 backend report](BACKEND_PERFORMANCE_REPORT_2026-09-12.md) for one local comparison.

## In-editor WebGPU benchmark

The multiple-light material path uses one fixed 592-byte uniform per scene, up from 144 bytes.
Its additional-light loop is bounded at seven iterations and does no texture sampling or new
render passes. Compare identical one-, two- and eight-light scenes at the same resolution and
shadow settings when assessing cost. This allocation/work bound is not a measured frame-time
guarantee. `scripts/gpu-scene-lighting-check.mjs` validates actual GPU color contributions and
attenuation independently of timing; run its `run()` export in a WebGPU browser on Vite.

The realtime Profiler provides **QUICK** (60 measured frames per scenario) and **FULL** (600 measured
frames per scenario) controls. Each run uses 10 warm-up frames, waits for submitted GPU work after
every measured frame, and tests the current composition at 1080p and 4K, a generated 20-layer 1080p
composition, and a fused Blur/Glow color-effect chain. The visual report shows GPU median and p95;
the download button writes the complete wall/CPU/GPU min, median, p95, p99, and max distributions as
schema-versioned JSON with adapter metadata.

An initial 60-frame run on the development WebGPU adapter measured 1.11 ms median / 1.31 ms p95 at
1080p, 4.59 / 4.92 ms at 4K, 3.47 / 3.80 ms for 20 layers, and 0.72 / 0.79 ms for the five-effect
Blur/Glow chain. This run predates the fixed-manifest policy and remains an observational smoke result
rather than a manifest-qualified baseline or cross-machine limit.

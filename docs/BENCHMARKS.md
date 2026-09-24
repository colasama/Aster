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

## Background export pipeline

Start unbundled Vite (`ASTER_BUNDLED_DEV=0`), import
`/scripts/gpu-export-pipeline-check.mjs` in an isolated WebGPU browser, and call `run()`.
The default fixture contains 20 animated shapes at 1080p, checks byte-identical serial/concurrent
captures at three frame addresses, warms ten frames, then measures 300 frames through the actual
RenderHost loop. Use `width`, `height`, and `frameCount` to select the workload. Results include
adapter diagnostics, total throughput, raw completion intervals, and their distributions. Use
`checkImageSequence()` from the same module to compare three cold-decoded image-sequence frames
under sequential and concurrent capture, including a known-color check for each source generation.
The default output callback discards pixels: label those measurements **readback-only**, not MP4
export speed.

For end-to-end MP4 measurements, supply an `output(request)` callback through an isolated Electron
preload/IPC bridge into `Mp4ExportManager` and set `outputKind: "ffmpeg-ipc"`. Use the manifest's
dimensions, rational frame rate, frame count, pixel format and 20 Mbps bitrate for encoder start;
await every write and finish. Time from `prepared` through `completed`, including encoder flush but
excluding adapter/shader initialization, parity checks, warm-up and encoder probing. The optional
`frameLoop` argument allows the unchanged prior RenderHost loop to run against the identical fixture,
renderer and encoder. Alternate old/new order for three runs at each resolution without concurrent
builds. Retain the JSON reports and verify encoded frame counts with FFprobe. These development
diagnostics are separate from manifest-qualified release baselines.

The [2026-09-22 diagnostics](../benchmarks/results/export-pipeline-2026-09-22/end-to-end.json)
used an RTX 5060 Laptop GPU (driver 32.0.15.9621), Ryzen 9 8945HX, Electron 43.4.1 and NVENC.
Median FPS across three 300-frame runs changed from 29.32 to 49.51 at 1080p and 8.93 to 9.27 at 4K.
Per-run throughput varied substantially: power and thermal state were not controlled, and these
observations do not establish a portable speedup. The initial
[three-slot run](../benchmarks/results/export-pipeline-2026-09-22/initial-three-slots.json)
and [depth sweep](../benchmarks/results/export-pipeline-2026-09-22/depth-sweep.json) are retained too.
The sweep found similar 4K throughput for two and three pending frames, supporting a 64 MiB raw
lookahead budget (three slots at 1080p, two at 4K) plus the writer's current frame. FFprobe found
300 H.264 frames at the expected resolution/rate in every final output; all six MP4 files at each
resolution have identical SHA-256 hashes across old/new loops and all runs. The
[verification record](../benchmarks/results/export-pipeline-2026-09-22/verification.json)
also records byte-identical cold image-sequence captures. Queue persistence and atomic publication
are outside this isolated encoder harness.

## Persistent scene preparation

The 2026-09-22 follow-up applies two documented rendering principles: Blender's
[Persistent Data](https://developer.blender.org/docs/release_notes/2.93/cycles/) retains expensive
render preparation between animation frames, and the After Effects SDK's
[Compute Cache](https://ae-plugins.docsforadobe.dev/effect-details/compute-cache-api/) keys reusable
calculations by all inputs that affect their result and accounts for retained memory. Aster uses
these principles for bounded local Bezier topology and per-call parent-transform reuse; it does not
use either application's code or SDK. Direct Float32 vertex packing additionally removes an
allocation/copy hotspot identified by Chromium's CPU profiler.

[AE Multi-Frame Rendering](https://helpx.adobe.com/after-effects/desktop/render-and-export/multi-frame-rendering/multi-frame-rendering.html)
depends on CPU, RAM and GPU resources. The vendor's
[BG Renderer MAX documentation](https://bgrenderer.com/docs/multiprocessing) describes multiple
`aerender` processes producing an image sequence before final video assembly. Aster already overlaps
bounded readbacks with ordered encoder writes. The follow-up retains that pipeline in **both** arms
of the comparison; it does not add duplicate renderer processes or claim AE-style parallel CPU
frame evaluation. More workers would not remove the measured per-frame preparation overhead.

`/scripts/render-persistent-data-check.mjs` exports two deterministic fixtures: `prepareVectors`
creates 20 curved paths with 160 control points each, and `prepareHierarchy` creates 240 rectangles
under three eight-joint parent chains. `profilePreparation()` measures flattening and geometry
separately over 120 frames after ten warm-ups. Supply `flatten` and `geometry` from the baseline
modules for the comparison. `checkGeometryParity({ baselineFlatten, baselineGeometry })` compares
every vertex byte and draw batch across 2D/3D, mirrored fractional scale, trim, control-point edits,
stroke style changes, path morphs, and non-monotonic times.

For end-to-end measurements, pass either fixture as `prepareComposition` to the existing export
harness, with the same IPC/NVENC callback described above. The optional `Renderer` and `createBackend`
parameters accept matched baseline renderer/backend modules (both must come from the same module
graph because backend selection checks renderer identity). Use 1080p, 300 frames, 30 fps and 20 Mbps,
alternate old/new order for three runs, and compare final MP4 hashes and FFprobe frame counts.
Restart the isolated Vite server after source edits and verify the served modules before timing;
never run checks/builds alongside the timed workload.

These are local, unbundled Electron diagnostics, not a comparison against Blender/AE or a
manifest-qualified release baseline. CPU preparation timings do not predict throughput for scenes
dominated by GPU effects, video decode or raw-frame transfer. The cache retains at most 128 entries
and 8 MiB of estimated CPU data; exact source-time transform memos last only one flattening call.

The [CPU preparation record](../benchmarks/results/persistent-preparation-2026-09-22/cpu-preparation.json)
reports a median-of-run-medians change from 30.0 to 12.8 ms for vector geometry and from 3.0 to
0.2 ms for hierarchy evaluation. On the same Ryzen 9 8945HX / RTX 5060 Laptop / Electron 43.4.1
machine, the [MP4 record](../benchmarks/results/persistent-preparation-2026-09-22/end-to-end.json)
contains these three-run median throughputs:

| 1080p fixture, 300 frames per run | Existing pipeline | Persistent preparation | Change |
| --- | ---: | ---: | ---: |
| 20 animated curved paths | 15.72 FPS | 22.68 FPS | +44.3% |
| 240 shapes under 24 parent joints | 39.16 FPS | 38.60 FPS | -1.4% |

The hierarchy result is effectively unchanged despite much lower evaluation time; remaining
render/readback/IPC/encoding work dominates that fixture. Vector export benefits from reducing
substantial geometry work. Neither result establishes a universal speedup, and this follow-up does
not establish a new 4K throughput figure. All twelve MP4 files contain 300 decoded H.264 frames;
the six files within each fixture have identical SHA-256 hashes. The
[verification record](../benchmarks/results/persistent-preparation-2026-09-22/verification.json)
also records byte equality for 6,720,000 vertex attributes over 16 mixed geometry cases. Source
hashes, raw timings and environment details are retained with the reports.

## Rendering hot paths

The [2026-09-22 camera preparation diagnostics](../benchmarks/results/render-hotpaths-2026-09-22/camera-projection.json)
compare the working tree after persistent preparation against a camera projector prepared once per
geometry build. Import `/scripts/render-projection-check.mjs` in an unbundled Vite browser.
`measure({ scene, geometry, frames: 600 })` accepts `vectors2d`, `vectors3d`, or `mesh3d` and a baseline
`buildSceneGeometry` function. Preserve the previous geometry and camera-rig modules together;
rewrite their imports so baseline geometry uses the baseline camera implementation. Both arms reuse
the same current Bezier cache and scene evaluation. Run three alternating-order comparisons after
20 warm-up frames, without concurrent tests or builds. Flattening is outside the timed interval.

The fixture contains eight animated curved shapes (8,682 vertices) or one rotating imported grid
mesh (9,600 vertices), at 1080p with the default camera. Median-of-run-medians CPU geometry times:

| Fixture | Before | After | Change |
| --- | ---: | ---: | ---: |
| 2D curves | 1.60 ms | 1.60 ms | 0.0% |
| 3D curves | 10.40 ms | 2.10 ms | -79.8% |
| Imported mesh | 12.30 ms | 3.00 ms | -75.6% |

`checkParity(baselineGeometry)` checks all packed vertex bytes and draw batches in 72 cases across
default, one-node and two-node cameras, perspective and orthographic projection, and non-monotonic
times. Another 16 cases reuse `render-persistent-data-check.mjs` for path edits, mirrors, trim,
stroke styles and morphs. All 130,421,760 compared vertex bytes were identical.

The [text preparation diagnostic](../benchmarks/results/render-hotpaths-2026-09-22/text-preparation.json)
measures the real warmed `MediaTextureCache.prepareText` method with mocked Canvas/GPU APIs. One
3,780-grapheme text resource receives 100 cache-hit calls per iteration; five iterations warm the
cache and 50 are measured. The CPU median changed from 126.13 to 1.25 ms per 100 calls after removing
an unused grapheme count. Both arms retain one texture, one initial upload and the same binding;
the optimized arm makes zero segmentation calls during cache hits. This single-run microbenchmark
includes a segmentation spy and is not a GPU timing, rendering FPS, or release baseline.

The [post-process GPU diagnostic](../benchmarks/results/render-hotpaths-2026-09-22/post-sampling.json)
uses `/scripts/gpu-post-sampling-check.mjs`. Pass the prior `postProcessShader` string to
`run({ baselineShader })`; preserve its imports when loading a baseline shader module. It checks
48 byte-identical HDR output cases spanning transparent/tiny-alpha pixels, linear/display output,
exposure/UV effects, and positive/negative legacy blur, glow and chromatic parameters. It then runs
three alternating comparisons with 120 warm-up passes and 600 samples per arm. Each sample measures
eight consecutive passes with GPU timestamps and divides by eight, reducing the observed 65.536 µs
timestamp quantization. Repeat at 1080p and 4K. These are batched full-screen pass timings with an
`rgba16float` target, not full-frame latency or export throughput.

| Legacy optical uniforms / resolution | Before median | After median | Change |
| --- | ---: | ---: | ---: |
| All zero / 1080p | 0.180 ms | 0.106 ms | -40.9% |
| All zero / 4K | 0.786 ms | 0.508 ms | -35.4% |
| All active / 1080p | 0.180 ms | 0.188 ms | +4.5% |
| All active / 4K | 0.795 ms | 0.836 ms | +5.2% |

The current renderer, layer effects and adjustment effects all supply zero legacy optical uniforms;
enabled layer effects run through compiled effect operations. The optimized path removes redundant
base sampling without disabling these operations. The synthetic all-active legacy path still has a
5.2% median regression at 4K, just above the policy threshold; it is recorded rather than treated as
a quality tradeoff or a universal speedup. Its p95 changed from 0.918 to 0.958 ms. At 1080p the
all-active p95 changed from 0.221 to 0.238 ms. The
[initial single-pass samples](../benchmarks/results/render-hotpaths-2026-09-22/post-sampling-initial.json)
and [two-guard experiment](../benchmarks/results/render-hotpaths-2026-09-22/post-sampling-two-guards.json)
are retained; the final single fast-path branch reduced the earlier active-path overhead.

These local measurements use Ryzen 9 8945HX / RTX 5060 Laptop hardware with Electron 43.4.1 and
driver 32.0.15.9621. The OS differs from the hardware manifest, and power/thermal state was not
controlled. Retained reports include raw samples and source hashes. CPU preparation gains do not
predict throughput when GPU effects, decoding, readback or encoding dominate.

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

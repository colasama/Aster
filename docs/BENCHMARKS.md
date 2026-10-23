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

Renderer migration checks use `pnpm migrate:verify --milestone <id>`. The full run executes the
static checks through lefthook, rebuilds the application, and exercises preview and render-queue
export in both foreground and background application sessions. It preserves the staged FFmpeg
binaries and checks their packaged hashes. Reports and step logs live under `artifacts/migration/`,
with source hashes and timings to identify the exact checked working tree. `--quick` omits the
application checks and some static checks; it cannot establish full G0 or milestone completion.
Development commits require full G0 plus affected-scope checks under the approved layered policy.
Passing these gates does not establish a performance baseline or complete the migration milestone:
the corpus, reference captures, pixel oracle, and measured baselines remain separate requirements in
[the migration specification](migration/RUST_RENDERER_MIGRATION.md).

Final M12 verification combines authored-project Rust exports and production native preview. Export
performance uses four balanced TS/Rust pairs over all five declared workloads, ten completed
same-session warm-up frames per observation and complete-export timing. It includes native audio
mixing, encoder creation, evaluation, rendering, encoding, mux and publication; initial loading,
audio decode, warm-up and subsequent probing are excluded. The native raster cache uses the
production 64 MiB setting. Preview uses three balanced pairs over seven scenarios and independently
checks input-to-present latency. Every native median FPS must exceed contemporary retained TS;
native p95 input latency must not exceed TS. Historical baseline percentages do not replace these
comparisons. Full output quality, audio and lifecycle acceptance remain independent gates.

The TS baseline and retained comparison harness described below are isolated reference programs.
Their RenderHost, browser readback and encoder-selection behavior do not describe the current
production renderer. Reports identify which path and source snapshot produced each observation.

`pnpm migrate:benchmark` builds an isolated production Electron benchmark bundle and measures the
existing `ProductionBeautyFramePipeline` through `runRenderHostFrameLoop`. This migration baseline
suite contains the complete owner opening, its following 300-frame main interval, deterministic
20-layer composites at 1080p and 4K, and a 1080p Blur/Glow/color effect chain. It is a throughput
baseline for these paths, not the complete preview, interaction, particle, or media benchmark suite.
The owner workloads run readback-only, ordinary `ipcRenderer.invoke` without encoding, and full
20 Mbps H.264 MP4 with actual composition audio. Synthetic workloads measure readback-only. A missing
owner project is recorded as skipped and cannot establish a complete baseline.

The complete ten-frame warm-up suite precedes three measured runs; each run also discards ten
warm-up frames. Workload order alternates and output-mode order rotates. Synthetic runs contain
600 frames each. Owner runs preserve the exact project-derived interval: 714 opening frames and
300 main frames on the current project, giving 2,142 and 900 measured frames per mode. The timer
runs from the production loop's `prepared` to `completed` events, including output backpressure,
audio mixing and encoder flush. Project loading, initialization, warm-up, audio decoding, encoder
probing and subsequent FFprobe validation are outside it. Video synchronization and bounded
readback concurrency follow the production assignment, including a single in-flight frame for
the owner project's reachable video layers. Frames keep the native BGRA/RGBA format.

Retained readback benchmark sessions use the original RenderHost `renderFrameInto` path and its
lazy CPU destination pool. Capacity is the clamped pipeline depth plus one writer-owned frame;
all pixels are still copied, and buffers remain leased until every PNG/MP4 output acknowledges
the frame. Initial pool allocations occur inside the measured interval. Warm-up, frame counts,
concurrency, timing boundaries and acceptance thresholds are unchanged; buffer reuse alone does
not establish a throughput improvement or a passing performance gate.

Reports retain each frame's completion interval and readback wall latency, per-run elapsed time
and throughput, actual encoder selection, output byte counts, and FFprobe stream evidence.
Quantiles use linear interpolation (R-7), matching the existing renderer benchmark reports.
Frame distributions and the distribution of three run throughputs have separate sample counts;
three run FPS values do not establish frame-latency p95/p99. Readback wall latency includes GPU
work and waiting and is not CPU execution time. Independent per-frame GPU timings are unavailable
because the current asynchronous profiler does not associate completed samples with frame ids.
The baseline does not substitute zero for unavailable measurements.

Source hashes enclose compilation and the measured suite; project/resource and actual FFmpeg binary
hashes are verified again afterward. Hardware, AC state, power scheme, display topology, driver and
the actual WebGPU adapter must match the committed local hardware manifest. The owner-authorized
Radeon 780M host has its own series in
[`windows-radeon780m-local.json`](../benchmarks/hardware/windows-radeon780m-local.json), with its
observed Balanced scheme; it is not compared with the historical RTX 5060 observations. No power
setting or unrelated application is changed. Thermal sensors and unrelated GPU workload occupancy
are not claimed as measured. Benchmark reports are written atomically under `artifacts/performance/`;
only a complete, stable run may be recorded as `benchmarks/results/migration-baseline.json`.
`--smoke` measures ten frames as a diagnostic. `--case <id>` and `--mode <mode>` restrict diagnosis;
none of these partial runs can qualify as the complete baseline. MP4 stream validation here does
not replace G5's decoded-pixel, quality, synchronization, pause or cancellation checks.

The [2026-10-03 local TS baseline](../benchmarks/results/migration-baseline.json) contains 14,526
measured frames plus the discarded warm-up suite. Median throughput over three runs:

| Workload | Readback only | IPC, no encode | Full MP4 with audio |
| --- | ---: | ---: | ---: |
| Owner opening, frames 0–713 | 22.26 FPS | 16.62 FPS | 14.88 FPS |
| Owner main, frames 714–1013 | 44.57 FPS | 31.90 FPS | 28.42 FPS |
| 20-layer 1080p composite | 281.02 FPS | — | — |
| 20-layer 4K composite | 74.38 FPS | — | — |
| 1080p effect chain | 170.35 FPS | — | — |

This host's existing export manager selected `libx264`; NVENC was unavailable. These measurements
do not satisfy or replace the migration's later native hardware encoder speed or quality gates.
Owner full-export frame-completion p95/p99 are 99.20/203.58 ms for the opening and 41.11/44.90 ms
for the main segment. These are frame intervals, not GPU execution times. Initial renderer setup
and the declared warm-up are excluded; on-demand resources reached later in the interval remain
inside the timer. The effect fixture uses bright input, non-neutral curves and exposure, Blur,
Glow and chromatic operations. Hashed raw per-run samples, FFprobe results and source provenance
are retained alongside the summary; private owner project data remains external.

M2 adds a separate production-present series before changing production frame planning.
`pnpm migrate:benchmark --suite preview --report <fresh-artifact-path>` measures the existing
`ProductionBeautyFramePipeline.present` route in the hidden Electron canvas, then awaits the
renderer queue's completion for each frame. It does not request pixel readback, enter the export
loop or use cached preview frames. The three fixed synthetic workloads (1080p composite, 4K
composite and 1080p effect chain) each run 600 measured frames in three rounds. A complete ten-frame
warm-up suite precedes measurement, and each measured round also discards ten warm-up frames.

Raw samples distinguish synchronous present-call time from wall time through GPU queue completion.
The tracked preview medians are run throughput and per-frame present-completion interval. No
animation-frame pacing is imposed: these measure the cost of production canvas presentation and
completion, not monitor scan-out, playback scheduling or input latency. These resource-free scenes
must not report pending media or GPU failures. Exact owner-video preview readiness is outside this
preview series; the existing owner readback, IPC and full-export measurements remain required.

The preview baseline is independently frozen in `benchmarks/results/m2-preview-baseline.json`;
it includes its complete raw observations and its file hash is pinned in the migration ledger.
It does not replace `migration-baseline.json` or its raw evidence. Hardware, adapter, power,
workloads, timing method and source provenance accompany both series. The original 24-median
comparison rejected throughput below 95% or intervals above 105% of the fixed reference. Those
limits and M8's original 75 fps required / 120 fps stretch targets remain historical references.
Missing, partial, changed or stale reports do not count as measured evidence.

On 2026-10-05 (Asia/Tokyo), the owner approved the migration ledger's
`owner_overrides.performance_delivery_policy` with kind `rust-delivery-v1`. M2 requires G0/G1/G3;
M4, M6 and M7 require G0/G3. Performance observations in these stages are optional diagnostics,
not repeated blocking gates. M8, M11 and M12 retain G4 for final native delivery: native preview
and export median FPS must exceed the independently retained TS program measured contemporaneously
on the same machine, using matched workloads and output quality. M11's input-to-present p95 must
also remain no worse than TS. Preserve the warm-up, repeated-run method and complete raw evidence,
with both program identities, inputs and hardware conditions bound to the comparison. The candidate
cannot supply its own reference. Native paired G4 support is still required; these TS benchmark
commands do not yet prove native acceptance.

`node scripts/migration/native-reference-export.mjs --out <fresh-artifact-directory>` executes
one full-export observation per selected workload through the independently retained TS runtime.
`--smoke` restricts observations to ten frames; repeatable `--case` selects diagnostic workloads.
The browser bundle, compiled Electron modules and bridge binary come from the ledger-pinned
historical series, rather than the candidate build. They are authenticated before launch and
after completion. The common harness registers its asset protocol before asynchronous audits and
checks that it matches the loaded runtime. Changes to the live candidate Electron/bridge do not
replace this reference. Changed retained files fail the audit.

Reference observations retain the original ten-frame per-run warm-up and prepared-to-completed
timing, with actual MP4 encoding and composition audio when present. Inputs must match the frozen
workload baseline; hardware/AC conditions, source, executed binary hashes and final output hashes
are checked again afterward. This is a reference execution component, not native G4 acceptance.
The native job now provides a preparation-only `warm` operation on the same retained device and
selected NV12 transport. Ten wrapping frame addresses execute without advancing the encoder or
input admission or compressed storage; completed GPU work is acknowledged with an authenticated plan proof.
The earlier supplied-plan diagnostic
`node scripts/migration/native-benchmark-export.mjs --out <fresh-artifact-directory>` executes
the candidate through the retained RenderHost frame loop and whole-job native export route.
M12 measures authored-project exports instead; this older observation cannot substitute for them.
It builds the performance HTML entry explicitly, preserves and executes its web/Electron/bridge/
native binaries, and rejects TS fallback. The browser captures production plans and immutable media
identities; the main process grants only paths authorized by the assigned project. Ten same-device
warm-ups precede timing. Source-bound PCM is decoded before timing as in the retained TS harness.
The prepared-to-completed interval includes all measured planning, admission, render/encode,
compressed storage, audio mixing and publication. Native mux creation remains inside this interval
because it follows whole-job admission; no native work is subtracted. A main-process interval from
first admission through finished MP4 rejects reports that omit observed work. Frame/PCM counts,
encoder drain, FFprobe output, private-file cleanup and before/after artifact hashes are verified.

Native export replies aggregate CPU wall intervals for plan decoding, input preparation, frame
validation, render submission, output completion and encoder drain. Warm-up frames are excluded.
Output completion includes waiting for earlier GPU submissions, so these intervals are not GPU
pass timings. Resource release, serialization and transport are outside those internal intervals;
the full end-to-end interval remains the throughput measurement.

Both observation commands accept `--run` and full-length runs remain single observations, not a
three-run baseline. `native-performance-gate.mjs` schedules four pairs in alternating order, reuses
a single native runtime snapshot and authenticates the retained TS runtime. It recomputes raw timing
statistics, matches native adapter identity to the active browser GPU, and requires higher native
median FPS on all five workloads. Two-pair ten-frame smoke runs and partial coverage cannot pass G4.
Independent G5 quality acceptance remains required. Queue enqueue-to-completion
diagnostics have a different timing boundary and cannot be compared directly with these FPS values.

The fixed-reference 5 percent limits and absolute 75/120 fps targets no longer block this migration.
Baseline files and all previous failed evidence remain unchanged and are not reclassified. This
override does not reduce pixel, quality or functional coverage, waive G0 or the full required gates
before commits, or narrow the M0–M12 migration scope. Repeat performance diagnostics only to answer
a concrete implementation question or establish the final native comparison.

The local manifest starts a new series when display conditions change. The additive
`windows-radeon780m-local-1920x1080-144hz` series preserves the original 2800×1260 files and uses
independent reference measurements at 1920×1080. Its reference is a retained production bundle,
audited against the ledger-pinned pre-plan evidence and the M1 source commit; it is not described as
a fresh rebuild. The report records historical renderer bytes and the current common harness
separately. Complete bundle files, bridge, inputs, encoder, method and output evidence are rechecked.
Neither a current optimized bundle nor a diagnostic subset can establish this reference.

Each fresh measurement hashes the executed web files and preserves create-new copies of the live
Electron and bridge artifacts before launch. The runner checks both live and preserved bytes after
completion. Later evidence audits use the preserved files, so rebuilding the current application
does not invalidate an earlier reference. Current candidates must use their own fresh web directory.

To measure that fixed reference, run `pnpm migrate:benchmark --reference-bundle` for each of
`--suite throughput` and `--suite preview`, using distinct `--report` paths and
`--hardware-manifest benchmarks/hardware/windows-radeon780m-local-1920x1080-144hz.json`.
`node scripts/performance-series-baseline.mjs <throughput-report> <preview-report>` audits and freezes
the additive descriptor without replacing an existing file. Pin its path and file hash in M2's
`performance_series` before comparisons use it. The series retains the original 24 median checks
and 5 percent limits as historical diagnostics under `rust-delivery-v1`. Results measured under
different display conditions, including previous failed runs, are never relabeled as comparable.

`pnpm parity:generate` materializes deterministic projects under `artifacts/parity/projects/` and
updates `tests/parity/corpus.json`. `node scripts/parity-generate.mjs --check` checks that the manifest
matches the factories and current registries. The corpus tests validate project structures, active
feature objects, stable project bytes, every layer/blend/effect/AA entry, and external frame addresses.
The owner project remains external through `ASTER_PERF_PROJECT`; its Intro layer determines the
opening interval and the following 300-frame main interval. Missing owner data is never performance
evidence. The Enchanted Love example is generated without a private soundtrack.

Committed procedural media includes byte hashes, generator provenance, fractional-rate video with
decoded frame barcodes and fixed GOP boundaries, SVG, PSD and image-sequence payloads. Reproduce it
with `node scripts/parity-media-assets.mjs --check` using the recorded staged FFmpeg build. Existing
TS support boundaries are explicit: EXR bytes are retained for native decode but rejected by the
current still-media sidecar, path masks assert schema coverage only, and point lights do not claim
shadow coverage. Audio-analysis cases require their declared example plugin to be installed and
loaded by the capture harness. Structural coverage does not establish GPU pixel correctness;
reference capture and pixel self-review remain separate checks.

`pnpm parity:capture` builds a dedicated hidden Electron harness and reads every corpus case through
the production beauty pipeline. Use repeated `--case <id>` arguments for a focused run; `--force`
recaptures an existing case. The harness uses an isolated application profile, explicitly loads
required plugins, synchronizes media at each rational frame address, and rejects resource or GPU
errors. It preserves raw RGBA8 bytes when writing PNG, including RGB beneath zero alpha. Sequence
cases also capture actual adjacent frames for later identity checks without changing the requested
seek order. References are written under `artifacts/parity/reference/<case>/<frame>/`; a separate
capture report and the raw host diagnostics identify their provenance.

Each capture case reuses one exact-sized raw readback destination and checks the returned buffer's
identity. RGBA normalization produces an independent owned buffer, and the next readback waits for
the previous frame's publication acknowledgement. Candidate captures therefore exercise the same
destination-copy path used by production exports; G3 retains its full corpus, pixel thresholds and
reference requirements without an exemption for buffer reuse.

Reference reuse requires matching renderer/capture source, project and media hashes, adapter
identity, and system font contents. Unavailable font provenance disables reuse. Each cached PNG and
metadata file is checked against its recorded hash. Completed cases remain staged until every
selected case succeeds and the launcher proves that source, fonts and case resources did not change
during the run, then publishes each complete case directory. Missing owner data reports a skipped case and
prevents a complete capture result. Capturing references does not compare or approve candidate
pixels, and the comparison command must never regenerate references.

The original minimal-golden example puts an opaque background above its animated disc. Its five
reference frames are therefore the same solid color; it preserves the existing example behavior
and does not establish visible animation. Generated moving scenes and media sequences exercise
time-addressed output independently.

Build the offline pixel oracle with `cargo build --release -p aster-render-cli`, then run
`target/release/aster-render-cli compare --reference <png> --candidate <png> --tolerance <profile>`.
Profiles are embedded from `tests/parity/tolerances.json`; the report records that catalog's SHA-256.
The `yuv` default requires 40 dB on every frame. No tolerance override is implicitly applied. Exit
codes are 0 for numeric/structural success, 1 for pixel failure, and 2 for invalid input or an I/O
failure. Non-exact profiles still need the agent's recorded image review before G3 can pass.

Maximum and mean absolute error and `mean_squared_error` include all four RGBA8 channels, including
hidden RGB. Profile PSNR uses RGB MSE (`rgb_mean_squared_error`); `rgba_psnr` also reports the RGBA
value. Each PSNR explicitly represents zero error in its channels as infinite. SSIM uses an 11×11
Gaussian window (sigma 1.5), population covariance and symmetric edge reflection. Its `channels`
report all four scores, `mean` gates the RGB average, and `rgba_mean` preserves the RGBA average.
Matching alpha cannot dilute either color gate; alpha error is checked separately by the structural
gate. Registration uses a zero-padded, phase-normalized Fourier
cross-spectrum and local upsampled DFT; no registration transform is applied to metric inputs.
Unobservable, periodic or incoherent nonidentical images fail the registration check. Coordinate-wise
identical images have a distinct identity result. Resource limits reject oversized work instead of
silently scaling down comparison inputs.

`--context <json>` supplies `{case_id, isolated, background, sequence}`. Isolated cases must name the
fixed RGBA8 background. A sequence supplies `{frame, first_frame, last_frame, previous, next}`; neighbor
PNG paths are relative to the context file. Both in-domain neighbors are required, and the candidate
must have strictly smaller RGBA mean squared error against the current frame than either neighbor.
Only a declared domain endpoint can omit its outside neighbor; equal neighboring frames cannot prove
identity. The batch gate obtains these facts from the corpus project rather than inferring endpoints
from the sampled reference list.

`--out <new-directory>` publishes `report.json`, `heatmap.png` and `contact-sheet.png` together. The
heatmap is opaque grayscale, `min(255, max RGBA error × 16)` by default. The contact sheet's top row
shows reference and candidate over a checkerboard using the production premultiplied sRGB convention;
its bottom row shows their alpha channels. All panels retain source resolution. Existing outputs
and references are never overwritten. Evidence includes both compressed-file and raw-pixel hashes.

`pnpm parity:oracle` proves both directions: unchanged reference pixels pass an exact diagnostic G3
comparison, while a candidate with a 20×20 erased patch fails the real GPU profile and structural
checks. The command saves each G3 report and the failed candidate's visual evidence under
`artifacts/parity/oracle/`. This diagnostic subset does not claim full corpus parity or completion.

G3 checks every reference and sequence neighbor against the ledger's approved
`reference_baseline.renderer_source_sha256`, in addition to capture, PNG and metadata hashes.
Recapturing a newer renderer cannot silently replace the approved oracle. A new baseline must first
pass an exact comparison against the preserved one. Accepted non-exact reviews bind the case, frame,
profile, raw image hashes, all measured results, and the SHA-256 of their report, heatmap and contact
sheet; missing or changed evidence cannot reuse a prior acceptance.

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
intentional quality tradeoff. The Rust migration's approved `rust-delivery-v1` acceptance policy above
overrides these blocking thresholds without changing the reported measurements.

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
policy of 5% median and 10% p95 timing thresholds. This library comparison remains a diagnostic under
the migration's `rust-delivery-v1` policy. Nightly CI stores the generated JSON as a build artifact so
results remain attributable to the exact commit and runner.

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

Native preview qualification runs three contemporaneous TS/native pairs in alternating order at
matched quality using the normal application bundle for Rust and a separate `reference`-mode bundle
for the retained TS viewport. Both bundles are built before timed sampling; the reference application
route is development-only. Both engines use 1024 MiB budgets and beauty quality. Each scenario
retains all 600 raw wall and CPU samples,
plus 600 GPU samples when available. Empty GPU sample arrays indicate unavailable GPU timing;
their zero summaries do not establish zero GPU cost. Acceptance uses measured wall throughput.
Reported distributions are recomputed from those samples. Every scenario's median FPS across the
three runs must exceed TS. These editor scenarios include 100K, 500K and 1M particle workloads.
Native samples include Electron's GPU-tracked import-release notification and the Rust surface
release acknowledgement. Returning from the texture transfer or submitting the canvas copy alone
does not complete a measured frame. Exclusive benchmarks return metrics without per-frame editor
diagnostics or mirror updates, matching the TS benchmark path.

Input latency is measured separately in the focused test application's owner-project timeline.
Real mouse clicks alternate between 24 and 26 seconds with the RAM frame cache disabled, AA off,
and a 1024 MiB GPU budget. Ten warm-up inputs precede 600 samples per arm. Electron presentation
subscriptions supply compositor frames; a sample ends only when the visible preview crop matches
the calibrated target image. Raw monotonic input/presentation times and PNG/hash witnesses are
retained. The combined native p95 over three runs must not exceed TS. This measures application
input-to-compositor-presentation, including the capture callback delivery, not physical display
scan-out. Focus loss, unchanged calibration images, missing target frames and stale identities
invalidate the run. Renderer completion time cannot substitute for these presentation samples.
Window and document focus are prepared with at most ten bounded attempts before geometry capture,
each calibration address and the measurement sequence. The attempt log is retained. Once warm-up
or sampling begins, focus loss fails the run without refocusing, replaying input or dropping samples.
Development qualification builds and pins the debug desktop bridge selected by the editor, alongside
the release renderer and packaged bridge, before starting timed work.
The exit audit requires the seven canonical scenarios exactly once per arm and recomputes summaries
from complete samples. It binds three paired runs, independent latency, application recovery and
complete corpus pixels to the same current verification invocation and executable identities.

An initial 60-frame run on the development WebGPU adapter measured 1.11 ms median / 1.31 ms p95 at
1080p, 4.59 / 4.92 ms at 4K, 3.47 / 3.80 ms for 20 layers, and 0.72 / 0.79 ms for the five-effect
Blur/Glow chain. This run predates the fixed-manifest policy and remains an observational smoke result
rather than a manifest-qualified baseline or cross-machine limit.

### Native authored-project export observations

`export --benchmark-warmup-frames 10` completes ten RGBA readbacks using the same native project
session, device and caches used for the subsequent export. Ordinary exports use zero warm-up
frames. The observation runner authenticates the same fixed workloads as retained TS and enables
the production queue's 64 MiB retained-raster payload cache. Omitting this setting disables
payload reuse and does not represent the production queue. The measured interval runs
from the native export start through atomic publication. This includes audio mixing, encoder
creation, project evaluation, rendering, encoding and mux work. Initial project loading, audio
decoding and the completed warm-up are excluded; no measured work is subtracted. GPU readback
witnesses are forbidden in timed observations. Native monotonic millisecond receipts provide
ordered frame intervals and total elapsed time; FFprobe and artifact hashing follow completion.

One observation, including a short smoke run, cannot establish G4. Final acceptance still requires
contemporaneous paired retained-TS observations, complete workload coverage, matching audio/video
parameters, stable hardware and binaries, higher native median FPS, and separate G5 quality.

The production G4 composition runs authored-project exports and editor preview sequentially. Export
uses four pairs in alternating TS-first/Rust-first order across all five canonical workloads; smoke
uses two short pairs and always remains incomplete. Each arm retains its original protocol: the
auditor reconstructs native timing from progress/receipts and TS timing from the retained benchmark
records. It binds matching inputs, audio, bitrate, active GPU, runtime files and raw output hashes,
then computes median FPS and completion-interval distributions. Preview separately requires all
seven scenarios and input latency across three pairs. Both suites must use the same renderer binary.

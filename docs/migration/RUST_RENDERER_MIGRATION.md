# Rust Renderer Migration Specification

Audience: an autonomous coding agent (Codex in goal mode) working in a verification loop with full
local permissions on the primary Windows development machine, on branch `feature/rust-renderer`
cut from `main`. The agent verifies and accepts every result itself through the pixel-level
comparisons and self-review in section 6; there is no human visual sign-off. The owner is involved
only for the `blocked` conditions in [Escalation](#escalation).

This document is the contract for the loop. The machine-readable state lives in
[`rust-renderer-progress.json`](rust-renderer-progress.json). The goal statement is
[`codex-goal.md`](codex-goal.md).

## 1. Goal

Move Aster's production renderer from the TypeScript browser-WebGPU implementation to a native Rust
renderer on wgpu, as already decided by ADR 0001 (Rust core) and ADR 0002 (wgpu). End state:

- One native renderer produces preview and export pixels from `evaluate(time)`.
- Export frames never leave the GPU between rendering and hardware encoding where the platform
  allows it; when it does not, the fallback is an in-process GPU readback of NV12, never a
  full-frame IPC transfer.
- Headless rendering (CLI, render farm) works without Electron once native evaluation lands.
- The TypeScript GPU renderer is retired from production paths.

Non-goals for this migration: changing project semantics, the project file format, the plugin ABI
contract, the UI, or the AI command surface. Any change to those requires escalation.

### Baseline that motivates the work

Primary machine: `benchmarks/hardware/windows-rtx5060-laptop.json`. Owner project "SD04PV / PV
showcase", 1080p, main segment, 300 frames × 3 runs, medians:

| Path | fps |
| --- | ---: |
| Render + readback, no transfer, no encode | 158.6 |
| + current IPC transfer, no encode | 43.1 |
| Current full MP4 export with audio | 37.3 |
| Experimental dedicated transfer channel, full export | 59.1 |

Each 1080p BGRA frame is 8.29 MB; the CPU/IPC hop dominates. The opening segment is additionally
bound by the GPU effect chain (per-layer effects run full-frame passes; see section 9).

## 2. Ground rules

Follow `AGENTS.md`, `crates/AGENTS.md`, and `DEPENDENCY_POLICY.md` exactly. Highlights that this
migration hits most often:

- Rust: no `unwrap`; methods on structs instead of free functions; `BTreeMap`; `tracing` for logs;
  configuration through clap-derived structs, not global constants; derive serde types instead of
  ad hoc JSON; no lifetime parameters where a cheap owned copy works.
- No source file approaches 1,000 lines. Split by responsibility first.
- GPU-first: frame data stays GPU-resident; no per-frame full-frame CPU copies in the native path
  except the documented NV12 readback fallback.
- Time-addressable evaluation: every frame is a pure function of (project revision, composition,
  rational time, target size, AA mode).
- No dirty data: an interrupted job never publishes a partial file; the default product path is never
  left half-migrated. New paths stay behind a capability gate until their milestone passes.
- `cargo fmt`, Clippy with `-D warnings`, Biome, typecheck, tests must pass before any commit.
- Gitmoji commits, focused, architectural intent in the body. Development commits require passing
  G0 and affected-scope verification; milestone exits require all milestone gates (section 8).
- Keep `docs/ARCHITECTURE.md`, `docs/PRODUCTION_RENDER_CONTRACT.md`, `docs/MEDIA_BACKENDS.md`,
  `docs/RENDER_QUEUE.md`, `docs/BENCHMARKS.md`, `docs/PROJECT_FORMAT.md` and `docs/PLUGINS.md`
  synchronized with each milestone that changes their subject.
- CUDA-only or single-vendor core paths are forbidden. Vendor encoders are optional adapters.
- New dependencies: allowed when they pass `cargo deny check` / `pnpm audit`, have a permissive or
  weak-copyleft license compatible with MPL-2.0, and are justified in the commit body. Escalate for
  GPL/LGPL static linking, bundled native C/C++ libraries, or anything that changes the shipped
  FFmpeg build.

## 3. Target architecture

### 3.1 Phases

- **Phase A — TypeScript evaluates, Rust renders.** The TS application keeps `evaluate(time)`,
  bounded animation expressions, text rasterization, and the editing model. It emits a `FramePlan` per frame
  (section 4). The Rust renderer executes every GPU pass. Pixel transport disappears; only plans
  (kilobytes) and cacheable resources cross process boundaries.
- **Phase B — Rust evaluates.** Timeline, animation, expressions, scene evaluation, text animators
  and effect-program compilation move to Rust, which then builds the same `FramePlan` itself. Plan
  equality against the TS builder is the gate. This unlocks headless export.
- **Phase C — Rust preview and retirement.** The viewport presents Rust-rendered frames through
  Electron `sharedTexture` import (GPU to GPU), and the TS WebGPU renderer leaves production paths.

### 3.2 Crates (new unless stated)

| Crate | Responsibility |
| --- | --- |
| `aster-render-ir` | `FramePlan`, resource descriptors, session protocol messages; serde + schemars; schema emitted to `schemas/frame-plan.v1.json` |
| `aster-render` (existing) | Render graph, transient allocation, resource pool; extended, not replaced |
| `aster-renderer` | wgpu scene renderer that executes a `FramePlan`: compositing, effects, text quads, media, 3D, AA, display transform |
| `aster-shaders` | Loads the shared WGSL sources (section 5), naga validation, pipeline-constant plumbing |
| `aster-media-native` | Native still/video/image-sequence decode into GPU textures with exact frame timing; uses `aster-video` probing |
| `aster-encode` | GPU NV12 conversion, platform hardware encoders (Windows Media Foundation first), Annex-B output; may absorb the Phase 0 `aster-gpu-encode` spike crate |
| `aster-eval` | Phase B native evaluation producing `FramePlan` from the project model |
| `aster-render-cli` | Thin clap binary: `render-plan`, `compare`, `serve` (Electron sidecar), `bench`, later `export` |

Keep crates cohesive; split further when a crate grows past one responsibility.

### 3.3 Runtime topology

```text
Electron renderer (TS)            Electron main                  aster-render-cli serve (Rust)
  evaluate(time) ──FramePlan──▶  forwards plans/resources ──▶  aster-renderer (wgpu, DX12 on Windows)
  text/svg/psd rasters (cached)   media authorization list        aster-media-native (video decode)
                                  FFmpeg mux (audio + -c:v copy) ◀── Annex-B ── aster-encode (NV12 + MF)
```

- The sidecar is a long-lived child process like `aster-desktop-bridge`, with newline-delimited JSON
  control messages and a binary framing for plan blobs and resources (section 4.3).
- The sidecar only opens media paths that Electron's render-media authorization granted for the job.
- Adapter selection must match the Electron GPU preference (`src/core/rendering/gpu-preference.ts`):
  same LUID, high-performance by default. Report adapter, backend, and driver in diagnostics.
- Electron main keeps owning FFmpeg muxing, audio PCM, atomic publish, and render-queue state.

## 4. FramePlan IR

### 4.1 Extraction rule

`FramePlan` is extracted from what `WebGpuRenderer#renderFrame` (`src/renderer/webgpu-renderer.ts`)
computes before encoding GPU commands: scene evaluation (`evaluation.sceneLayers`, geometry batches),
text motion-blur plans, camera and optics, the render stack (`planSceneRenderStack`), precomposition
surface plans, time-addressed motion vectors, depth-effect settings, lights and shadow quality,
scene-generator invocations with audio-analysis inputs, per-layer compiled effect programs
(`compileEffectProgram` op data), blend modes, mattes/masks, AA mode, and the production beauty
settings (`PRODUCTION_BEAUTY_SETTINGS`).

The decisive first step is to make the **TS renderer itself consume the plan**: split `#renderFrame`
into `buildFramePlan(request) -> FramePlan` and `executeFramePlan(plan)`. When the TS renderer renders
byte-identically through the plan, the plan is proven complete. Only then does Rust execute it.

### 4.2 Content

- Header: plan version, project revision, composition id, rational time, target size, AA mode,
  color pipeline, frame-rate, motion-blur shutter interval.
- Passes in execution order, mirroring the render stack: draw batches, effect groups (fused op data,
  blur/glow pyramid requirements, LUT reference), adjustment layers, backdrop blends, precomposition
  surfaces (recursive sub-plans or surface references with cache keys), depth/DoF, motion blur,
  scene generators, final display transform.
- Resources by content hash only: media sources (source id, authorized path, exact source time),
  text rasters, SVG/PSD rasters, LUTs, meshes, materials, HDR environments, plugin shaders.
- Large numeric arrays (vertex data, instance data, motion vectors, effect op data) as binary blobs.

### 4.3 Encoding

A container named `FPLN`: little-endian magic + version, a JSON metadata section (serde types from
`aster-render-ir`), then 16-byte-aligned binary blobs addressed by `(offset, length, element type)`.
TS writes with `DataView`; Rust reads blobs without copying. The JSON section alone must be readable
for debugging (`aster-render-cli render-plan --dump`).

Resources travel separately as `PutResource { hash, kind, descriptor, blob }` once per session and
are evicted with explicit `EvictResource` messages under a byte budget mirroring
`src/core/rendering/gpu-memory-policy.ts`. A plan referencing an absent hash is a typed error, never
a silent black frame.

## 5. Shared shaders

All WGSL currently lives in TS string literals (`src/renderer/gpu/shaders.ts`, `base-shaders.ts`,
`auxiliary-surface-shader.ts`, `effects/*`, `effects/shaders/*-shader-cases.ts`,
`effects/programs/*`, `compositing/*`, `scene/bundled-particle-generator.ts`,
`text/text-motion-blur-raster-cache.ts`, `diagnostics/buffer-visualizer.ts`).

- Move every shader to `shaders/**/*.wgsl` as the single source of truth.
- TS imports with Vite `?raw` (also in Vitest). Rust embeds with `include_str!` through
  `aster-shaders`.
- Where TS assembles shaders from fragments (effect shader cases, opcodes), define the assembly as a
  declarative manifest (`shaders/manifest.json`: fragment order, constants, entry points) consumed by
  both sides. Do not duplicate assembly logic by hand in two languages.
- Use WGSL override constants instead of string templating where possible.
- `crates/aster-render/examples/effect_shots.rs` and `src/renderer/gpu/effect-shot-manifest.test.ts`
  already prove the TS-dump → Rust-render path; fold them into the parity harness.

## 6. Verification system

The loop is only as good as its oracle. Milestone M0 builds it before any renderer work.

### 6.1 Corpus

`tests/parity/corpus.json` lists cases `{ id, project, composition, frames[], size, aa, features[],
tolerance }`:

- `examples/projects/minimal-golden.aster.json` (manifest frames) and `examples/projects/enchanted-love`.
- Generated per-feature projects (script under `tests/parity/generators/`) covering: every layer
  kind in `LAYER_KINDS`, every blend mode in `BLEND_MODES`, every entry in `EFFECT_REGISTRY`, layer
  styles, masks/mattes, nested precompositions, adjustment layers, text animators, each AA mode,
  camera/DoF, motion blur, lights/shadows/meshes/HDR environment, bundled particles, cloner,
  image sequences, SVG, PSD, video at fractional rates (23.976, 29.97) and at seek boundaries.
- The owner's performance project via `ASTER_PERF_PROJECT`. On the primary machine it is
  `D:\code\SD04PV` (`project.json` plus a 334 MB `assets` directory); never commit or copy it into
  the repository. Its root composition is "PV 展示栏" (`ab7c9863-702d-4546-bc20-35f233017b77`,
  1920×1080, 30 fps, 522 s) with no markers. Derive the opening segment from the in/out points of
  the "开场 Intro" precomposition layer and define the main segment as the 300 frames that follow
  it; record both frame ranges in `benchmarks/results/migration-baseline.json` and reuse them for
  every measurement. Missing variable or path means perf gates on it report `skipped`, not `passed`.

### 6.2 Reference capture (TS oracle)

`pnpm parity:capture` launches Electron headless with a dedicated harness entry (hidden window,
WebGPU, production beauty pipeline, `paintWhenInitiallyHidden`, no throttling). For each case and
frame it writes to `artifacts/parity/reference/<case>/<frame>`:

- `frame.png` (lossless RGBA8 readback through `ProductionBeautyFramePipeline`),
- `plan.fpln` and referenced resources (after M2),
- `meta.json`: Aster commit, TS renderer source hash, adapter, backend, driver, timings.

References are cached by (TS renderer source hash, case hash, adapter). Never regenerate references
inside the command that compares against them. After Phase C retires the TS renderer, the last
approved references are frozen under `tests/parity/frozen/` (PNG, no Git text conversion; respect
`.gitattributes`).

### 6.3 Native render and comparison

- `aster-render-cli render-plan --plan <fpln> --resources <dir> --out <png>` renders headless.
- `aster-render-cli compare --reference <png> --candidate <png> --tolerance <profile>` emits JSON:
  max abs channel error, mean abs error, PSNR, count of pixels above tolerance, and a diff heatmap PNG.
- Plan parity (Phase B): `aster-render-cli plan-diff --a <fpln> --b <fpln>` compares structure exactly
  and floats with relative tolerance `1e-5` (absolute `1e-6` near zero), reporting the first
  differing path.

### 6.4 Tolerance profiles (`tests/parity/tolerances.json`)

| Profile | Rule |
| --- | --- |
| `exact` | Byte-identical. Used for TS-through-plan refactors and resource round trips. |
| `gpu` (default) | max abs ≤ 2 code values (matches `scripts/gpu-color-check.mjs`), mean abs ≤ 0.05, PSNR ≥ 50 dB |
| `decode` | Video decoded by a different decoder: max abs ≤ 4, mean abs ≤ 0.5, PSNR ≥ 42 dB |
| `yuv` | Decoded MP4 vs reference RGB: PSNR ≥ 40 dB per frame, no frame below 36 dB |
| `perceptual` | Different rasterization engines (native text shaping, SVG): SSIM ≥ 0.99 per frame, PSNR ≥ 38 dB, plus the strict structural limits in 6.6 |

Every profile other than `exact` also requires the structural checks in 6.6 to pass. Tolerance
changes follow 6.6; loosening `exact` is never allowed.

On 2026-10-13 (Asia/Tokyo), the owner approved `layered-nv12-and-uniform-reference-v1`.
For G5 decoded-video comparisons, derive an independent reference from the frozen RGB image
through one uncompressed BT.709 limited-range NV12 conversion and the same accurate RGB decode
conversion used for the candidate. Bind the original, opaque RGB, NV12 and decoded reference
hashes, conversion commands and tool hashes. Convert adjacent frame references identically.
G3 still checks the original frozen RGB and independent NV12 conversion. Matched-bitrate
comparative VMAF (or SSIM/PSNR fallback) still uses the original lossless RGB reference conversion.
All existing numerical, structural, sequence, audio, stream, lifecycle and self-review requirements
remain; preserve previous failures and original RGB diagnostics without reclassifying them.

### 6.5 Gates

`pnpm migrate:verify [--milestone <id>] [--quick]` runs the gates required by the milestone, writes
`artifacts/migration/verify-<timestamp>.json`, prints a one-screen summary, and exits non-zero if
any required gate fails. Gate ids:

| Gate | Content |
| --- | --- |
| `G0-static` | `cargo fmt --all --check`; `cargo clippy --workspace --all-targets --all-features -- -D warnings`; `cargo test --workspace --all-features`; `pnpm exec biome check .`; `pnpm typecheck`; `pnpm vitest run` |
| `G1-ir` | Schema regenerated and unchanged in git; FPLN round-trip tests (TS write → Rust read → Rust write → TS read, `exact`) |
| `G2-plan` | Phase B plan parity over the whole corpus |
| `G3-pixel` | Native render vs reference per case and tolerance profile; GPU tests run here, not in `G0` |
| `G4-perf` | Under the approved `rust-delivery-v1` policy below, final native preview/export median FPS must exceed contemporaneous retained TS on the same machine at matched workloads and quality; retain M11's latency requirement |
| `G5-export` | Full export E2E: ffprobe stream/frame count/duration, decoded frames vs reference (`yuv`), audio present and in sync, cancel and pause leave no published or temp files |
| `G6-app` | Electron app smoke: `scripts/automation-smoke.mjs`, background render queue job, preview opens; Phase C adds latency checks |

GPU-dependent Rust tests stay `#[ignore = "requires GPU"]` in `G0` and run in `G3`.

On 2026-10-05 (Asia/Tokyo), the owner approved the ledger's
`owner_overrides.performance_delivery_policy` with kind `rust-delivery-v1`: deliver the complete
Rust preview/export migration and require final native median FPS to exceed the independently
retained TS program run contemporaneously on the same machine, with matched workloads and output
quality. M2 requires G0/G1/G3; M4/M6/M7 require G0/G3, recording performance when useful without
repeated hard performance gates. M8/M11/M12 retain G4. Implement and verify native paired G4 before
those exits; existing TS diagnostics do not establish native performance acceptance.

The original fixed-reference 5% limits and M8's 75/120 fps targets remain historical references,
not blocking conditions for this migration. Baselines and prior failed evidence remain frozen;
no failed run is reclassified. All M0–M12 functionality, pixel and quality checks, G0 and M11 latency
remain required. The owner's 2026-10-23 layered-verification approval in section 8 supersedes the
original full-required-gates-before-each-commit rule. Performance diagnostics should answer concrete
implementation questions or establish final native acceptance.

### 6.6 Pixel-level self-review

The agent is the reviewer. Aggregate error metrics alone can hide a missing glyph, a shifted layer,
or a color-matrix bias, so every non-`exact` comparison also runs these structural checks in
`aster-render-cli compare` and records them in the JSON report:

| Check | `gpu` / `decode` / `yuv` | `perceptual` |
| --- | --- | --- |
| Error clusters: 8-connected components of pixels with any channel error > 16 code values; largest component area | ≤ 64 px | ≤ 256 px |
| Signed bias: mean signed error per channel (catches gamma, range, or matrix shifts) | ≤ 0.5 code values | ≤ 1.0 code values |
| Alpha coverage: pixels whose alpha differs by > 8 | ≤ 0.1% | ≤ 0.5% |
| Registration: sub-pixel translation estimated by phase correlation | ≤ 0.25 px | ≤ 0.5 px |
| Ink bounds: bounding box of non-background pixels per layer-isolated case | ±1 px | ±1 px |
| Frame identity (sequences): candidate frame N matches reference N better than N−1 and N+1 | required | required |

The owner's 2026-10-13 approval permits one G5-only registration alternative: an exhaustive
scan must establish an exactly uniform opaque RGBA reference, identical candidate alpha, and
an error of at most one code value in every candidate RGB channel. Report
`uniform_reference_equivalence` with `shift: null` and an explicit unobservable-translation
diagnostic, never a measured zero shift. All other checks and agent self-review remain required.
Nonuniform references, larger errors, alpha differences and non-G5 profiles retain the ordinary
registration rule. Exact identity and measured registration remain unchanged.

On 2026-10-15 (Asia/Tokyo), the owner approved two narrowly scoped additions recorded in
`owner_overrides.material_reference_policy` and `owner_overrides.layered_structural_policy`:

- Correct only frame 0 of `scene-lighting-directional`, `scene-lighting-point`, and
  `scene-lighting-spot` after the material-readiness fix. An independently published cold TS
  capture must match the reviewed corrected pixels exactly; all nine later declared frames must
  remain identical to the original references. Preserve original files and rejected comparisons.
- G5 may use authenticated, same-source, same-case, same-frame native RGB, NV12, and pre-encode
  structural evidence for encoded ink-bound failures or unobservable registration. A measured
  shift beyond 0.25 px still fails. Encoded PSNR, error clusters, signed bias, alpha coverage,
  frame identity, relative quality, timing, audio and lifecycle limits remain unchanged.
  Publish the layered verdict separately from the original failed comparison and self-review it.
  The independent root and recursive export diagnostics use this same rule. Their witnesses bind
  directly to the diagnostic production capture's plans, resources, media authorization and adapter;
  corpus replay plans cannot substitute for those inputs. Diagnostic success never supplies missing
  corpus, owner-project or application-lifecycle coverage.

These authorizations do not relax other profiles or authorize general structural reference repairs.

Review procedure for each non-`exact` case:

1. Run `compare`; all metric and structural limits of the case's profile must pass.
2. Inspect the generated side-by-side contact sheet and diff heatmap images directly. Image
   inspection can only reject a result (for example a visibly wrong element the metrics missed;
   then add a structural check that catches it); it never overrides a failing metric.
3. Classify the residual error: `float-precision` (FMA, operation order), `decoder-rounding`,
   `sampling-order`, `shaping-hinting`, or `structural`. A `structural` residual is a bug: fix it.
4. Append a record to the ledger `self_reviews`: case id, profile, metrics, structural results,
   residual class, verdict, evidence paths.

Tolerance changes: the agent may loosen a non-`exact` profile for specific cases without
approval only when the residual is classified non-structural, every structural check still passes
at its profile's limits, and the loosened values stay within the hard floor: max abs ≤ 8 code values,
PSNR ≥ 40 dB (36 dB for `perceptual`), SSIM ≥ 0.995 (0.99 for `perceptual`). Record each change in
`tolerance_overrides` with the measured numbers and cause. Beyond the hard floor the result fails;
fix the implementation.

## 7. Milestones

Work strictly in order unless the ledger marks a milestone `parallel_ok`. Each milestone lists its
required gates; `G0` is always required.

### M0 — Verification harness and loop infrastructure

- Create the corpus, generators, reference capture, `compare`, tolerance profiles, gate runner,
  `benchmarks/results/migration-baseline.json` (current TS numbers on the primary machine, including
  the owner project when available), and the ledger fields the runner updates.
- Exit: `pnpm migrate:verify --milestone M0` passes; references captured for every case; a
  deliberately perturbed candidate image fails `G3` (prove the oracle can fail).
- Gates: G0, G6.

### M1 — Shared WGSL

- Section 5. TS renderer output unchanged.
- Exit: `G3` with the **TS** renderer as candidate against pre-change references under `exact`;
  every shader passes naga validation in `aster-shaders` tests; no WGSL string literals remain in
  `src/` (enforce with a test).
- Gates: G0, G3.

### M2 — FramePlan IR, TS executes through the plan

- `aster-render-ir`, schema, TS `buildFramePlan` / `executeFramePlan`, FPLN writer/reader, resource
  messages.
- Exit: TS renderer through the plan is `exact` against M1 references for the whole corpus; FPLN
  round trip `exact`; capture writes `plan.fpln` for every case.
- Gates: G0, G1, G3. TS performance observations are diagnostic under `rust-delivery-v1`.

### M3 — Native renderer core

- `aster-shaders`, `aster-renderer`, `aster-render-cli render-plan`. Headless wgpu device. Covers:
  solid, image (PNG/JPEG/EXR), shape and vector geometry, transforms, all blend modes including
  backdrop blends, masks and mattes, adjustment layers, precomposition surfaces and their cache,
  AA off/FXAA/SSAA2x/SSAA4x, linear-HDR to sRGB display transform with premultiplied alpha restore.
- Exit: `G3` `gpu` profile for all core cases.
- Gates: G0, G1, G3.

### M4 — Effects

- Fused effect programs from plan op data, blur and glow pyramids, LUT 3D (trilinear and
  tetrahedral), layer styles, surface post effects, chromatic aberration, Filmic/ACES effects.
- Implement the section 9 fixes **only in the native renderer** and only if parity holds.
- Exit: every `EFFECT_REGISTRY` entry and layer-style case passes `G3`.
- Gates: G0, G3. Record native effect-chain timings when useful; they do not block this stage.

### M5 — Text, SVG, PSD rasters (Phase A)

- TS supplies rasters by content hash through `PutResource`; Rust caches and draws them, including
  text motion-blur raster caches.
- Exit: text, SVG, PSD cases `G3` `gpu`.
- Gates: G0, G1, G3.

### M6 — Native media decode

- `aster-media-native`: exact-frame video decode honoring `docs/PRODUCTION_RENDER_CONTRACT.md`
  "Video timing" (rational times, seek boundaries, fractional rates), image sequences, color metadata.
  Start with FFmpeg-process decode plus upload; add D3D11VA/D3D12 surface interop as a measured
  optional path (`docs/MEDIA_BACKENDS.md` capability rules: only a checksum-verified import may claim
  `zero_copy`).
- Exit: video cases `G3` `decode`; frame identity exact (no off-by-one at any seek boundary).
- Gates: G0, G3. Record media performance when useful; it does not block this stage.

### M7 — 3D, camera, lights, motion blur, generators

- Camera and optics, DoF tiers, lights and shadows, meshes and materials, HDR environment,
  time-addressed motion vectors and reconstruction, bundled particles through the scene-generator
  WGSL ABI (`src/renderer/scene/scene-generator-abi.ts`) with audio-analysis inputs, cloner,
  auxiliary buffer views.
- Exit: all 3D and generator cases `G3`.
- Gates: G0, G3. Record scene performance when useful; it does not block this stage.

### M8 — Native export path

- `aster-render-cli serve` sidecar; Electron render queue routes a job to it when the capability
  gate accepts every feature in the job's plans and the encoder probe succeeds; otherwise the current
  path runs unchanged and the job report says why.
- TS render host streams plans and resources (Phase A). Rust renders, converts to NV12 in WGSL
  (BT.709 limited range, chroma siting matching current FFmpeg output), and encodes with a hardware
  Media Foundation H.264 MFT. Interop order: wgpu DX12 texture shared to the encoder device (zero
  copy or GPU copy); fallback: in-process NV12 readback (3.1 MB/frame at 1080p) fed to the encoder.
  The encoder never silently falls back to a software or legally different encoder.
- Annex-B to the existing FFmpeg mux with `-c:v copy`, existing audio pipe, existing
  `h264_metadata` color flags, atomic publish, pause/cancel semantics.
- Exit: `G5` on the corpus and owner project; `G4` native full MP4 export median FPS exceeds
  contemporaneous retained TS at matched workloads and quality, including the owner's main segment.
  Report median/p95/p99. The original ≥ 75 fps (2× baseline) / ≥ 120 fps stretch targets remain
  historical references and are not blocking requirements under `rust-delivery-v1`.
- Encoding quality is accepted automatically: export the corpus and the owner project's main segment
  at the same bitrate through the native path and the current FFmpeg NVENC path, decode both, and
  score each against the lossless reference frames. Use VMAF when the bundled FFmpeg has libvmaf;
  otherwise FFmpeg `ssim` and `psnr` filters. Both encoders use the fixed bundled
  `vmaf_v0.6.1neg` model, designed for codec comparison without image-enhancement gain. Record
  the model, authenticated FFmpeg binary and exact command for both arms; an unavailable model
  fails instead of selecting another model or metric. Pass when native VMAF ≥ current − 1.0, or when SSIM
  ≥ current − 0.002 and PSNR ≥ current − 0.5 dB. On failure tune Media Foundation rate control
  (rate-control mode, quality-versus-speed, GOP, B-frames off) and re-measure; record every attempt.
- Gates: G0, G3, G4, G5, G6.

### M9 — Native evaluation (Phase B)

- Reconcile `aster-types` / `aster-project` with the current TS project format so every fixture and
  example deserializes losslessly (round-trip test against `docs/PROJECT_FORMAT.md` and schemas).
- `aster-eval`: keyframes and easing, graph-editor curves, expressions (a native Rust parser matching
  the current bounded TS language and determinism), scene evaluation, text animators, effect
  parameter evaluation and op compilation, audio analysis inputs.
- On 2026-10-18 (Asia/Tokyo), the owner approved replacing the QuickJS assumption with the
  native Rust parser. Preserve existing operators, functions, `time`/`value`, the 2,048 UTF-16
  code-unit, 512-token and 32-level limits, and error fallback; verify against the TS evaluator.
  The existing QuickJS WASM runtime for AI editing scripts is independent and remains unchanged.
- `aster-render-cli export --project --composition --out` headless.
- Exit: `G2` plan parity over the whole corpus at every listed frame plus 64 random times per case;
  headless export passes `G5`.
- Gates: G0, G1, G2, G3, G5.

### M10 — Native text shaping and rasterization

- Replace TS text rasters with a native shaper/atlas (font discovery from `aster-text`, project font
  embedding, fallback chains).
- Compare against the TS reference rasters with the `perceptual` profile and 6.6 self-review. In
  addition, per-glyph advances and baselines must match TS layout within 0.5 px and line breaks must
  be identical.
- Fonts or scripts that cannot meet these limits keep the M5 TS raster path behind the capability
  gate; record them as ledger tasks instead of loosening beyond the hard floor.
- Exit: every text case passes, or is explicitly routed to the M5 path with a recorded reason.
- Gates: G0, G3.

### M11 — Rust preview (Phase C)

- Rust renders preview frames into shareable textures; Electron imports them with
  `sharedTexture.importSharedTexture` and the viewport draws the resulting `VideoFrame`. Project edits
  reach Rust as typed operations or snapshots; direct-manipulation previews stay time-addressed.
- Integrate with the RAM preview frame cache and playhead pre-renderer
  (`src/core/rendering/preview-frame-cache.ts`, `src/renderer/frame-cache/`).
- Exit: preview pixels `G3`; in-editor benchmark (`docs/BENCHMARKS.md` "In-editor WebGPU benchmark")
  shows native preview median FPS above contemporaneous retained TS at matched workloads and quality;
  input-to-present p95 latency remains no worse than TS.
- Gates: G0, G3, G4, G6.

### M12 — Retire the TS GPU renderer

- Remove the TS WebGPU renderer from production paths; freeze references. Keep the Canvas 2D
  compatibility renderer unchanged as a non-production preview fallback. Update every affected
  document.
- Gates: all.

## 8. The loop protocol

The agent works in cycles. A cycle is one task increment within a long-running goal session; the
ledger, not conversation memory, is the source of truth, so a cycle must also be correct when it
starts from a fresh session. In every cycle the agent must:

1. Read this specification, `rust-renderer-progress.json`, and the newest
   `artifacts/migration/verify-*.json`.
2. If `status` is `blocked` or `done`, stop immediately without changes.
3. Select the active milestone (first not `done`) and its first open task. If none is listed, break
   the milestone into tasks of at most a few hours each and write them to the ledger before coding.
4. Implement the smallest increment that moves a required gate toward green. Keep the default
   product path intact behind capability gates.
5. During development, run full G0 through the repository's lefthook migration-static command and
   the verification commands covering the increment's affected behavior. Use
   `pnpm migrate:verify --milestone <id> --quick` where useful, but skipped checks do not count as
   passing G0. Run `pnpm migrate:verify --milestone <id>` in full at milestone exit and final delivery.
6. On green G0 and affected-scope verification for the increment: commit (gitmoji, intent in body),
   mark only the completed task done, and record validation scope, evidence, commit hash and timings
   in the ledger. A development commit does not establish a passing milestone exit.
7. On red: fix and re-run within the same cycle. If the same gate fails with no measurable
   improvement across 3 consecutive cycles, set `status: "blocked"` with the evidence.
8. When every task and required gate of a milestone is green with a full run, mark the milestone
   `done`, update docs, commit, and continue with the next milestone in the next cycle.
9. At the end of every cycle, write `last_cycle` (time, milestone, task, outcome, next step) to the
   ledger. Never stop with uncommitted changes that break `G0`; unfinished work must be either
   committed green or reverted.
10. Rebase on the owner's base branch only when the ledger's `sync.requested` flag is set; resolve
    conflicts by preserving owner changes. After rebase, re-run the full gates of all `done`
    milestones affected by changed files.

On 2026-10-23 (Asia/Tokyo), the owner approved `layered-development-verification-v1`: development
increments may commit after G0 and targeted verification of affected behavior pass. Complete pixel,
performance, application and export gates run at their applicable milestone exits and final delivery.
Retain failed reports and explicitly record deferred milestone gates; do not relabel a failed full
run or use targeted checks to declare the milestone done. Repair failed checks with targeted runs
before attempting another complete exit run. The section 11 completion criteria, pixel self-review,
quality limits and performance acceptance are unchanged. This approval changes verification frequency,
not acceptance thresholds or the checkpoint authentication rules below.

Checkpoint reuse after the diagnostic-verifier repair requires complete before/after file inventories
whose digests reproduce the original and current execution identities. Only the explicitly enumerated
verification files may differ; any runtime, shader, fixture, dependency or tolerance-catalog change
invalidates reuse. Keep original source identities and failed reports intact. Re-audit every checkpoint's
inputs, binary, artifact hashes, numeric results and self-reviews under the current verifier; compatibility
alone grants no gate. The full current-source G0, G3, G4, G5, G6 and milestone-exit checks remain required.

M9 may resume a complete native-project G2 report with `--project-corpus-resume` and native-project
G5 checkpoints with `--export-resume`. The explicit verification-file list also covers their
checkpoint auditors and shared native-witness reference-catalog orchestration. Reconstruct every
current corpus address and request, authenticate original project commands and receipts, and recheck
all plans, resources, images, comparator logs and complete coverage. Retain original execution source
identities and reports. Sharing the already authenticated repair catalog avoids repeated image
decoding; byte-stability checks, current self-reviews and every numerical limit still apply. Frozen TS
producer files remain unchanged. Partial or supplied-plan captures cannot establish complete G2.

The final M9 exit audit binds the current invocation's on-disk gate reports to its in-memory
results, reconstructs the complete project and sample coverage, and authenticates pixel reviews and
original native project commands. It does not repeat the complete G2/G5 artifact scan already
performed by those gates in the same invocation. The enumerated verification-file list also includes
the M9 exit modules, their tests, the split verifier tests, and the synchronized architecture document.
When reused checkpoints have multiple historical execution identities, authenticate each complete
historical inventory directly against the same current inventory; never rewrite the original
identities or infer compatibility transitively. Reject NUL separators in inventory paths and identities.

The M10 exit audit consumes the current full G0/G3 invocation, reconstructs authored text coverage,
and binds admitted production samples to per-glyph layout, physical font identities and reviewed
GPU pixels. Explicit retained capability tasks account for the remaining M5 paths. The exit audit
does not repeat image decoding already authenticated by the same invocation's text gates.

### Moving-target rule

While the migration runs, any new TS renderer feature arriving from the base branch must either
already use shared WGSL and the plan, or be added to the capability gate's unsupported list with a
ledger task to port it.

## 9. Known performance work to fold in

Apply in the native renderer during the milestone that owns the code, measured by `G4`:

- Per-layer effects render full-frame passes regardless of layer bounds
  (`src/renderer/effects/layer-effects.ts`): restrict passes to the transformed layer bounds plus
  effect padding (scissor/viewport or right-sized textures).
- Blur/glow pyramids always build every mip level (`blur-pyramid.ts`): build only the levels the
  largest radius needs; share downsampling between blur and glow on the same layer.
- SSAA multiplies effect cost by 4× or 16× (`anti-aliasing.ts`): evaluate low-frequency effects at
  output resolution where parity allows.

An optimization that changes pixels is accepted only when the optimized native output passes the
`gpu` profile and the 6.6 structural checks against the unoptimized native output across the whole
corpus. Otherwise drop the optimization or keep it disabled for the failing cases.
- Cache post-effect results of layers whose evaluated inputs are time-invariant, keyed by input hash,
  GPU-resident and budgeted.

## 10. Escalation

Pixel acceptance, tolerance changes within the hard floor, pixel-changing optimizations, and
encoding quality are decided by the agent through section 6.6 and the milestone rules; they never
stop the loop. Set `status: "blocked"` and stop only when one of these occurs:

- 3 non-improving cycles on one gate; missing hardware capability; a dependency that
  needs approval (section 2); a required change to project format, plugin ABI, AI command schema, or
  user-visible behavior; owner project unavailable when a gate requires it; any destructive operation
  outside the migration worktree.

Write the reason, the evidence paths, and a concrete question for the owner into the ledger.

## 11. Definition of done

All M0–M12 milestones `done`; all required gates green on the primary machine; documentation
synchronized; all production preview and export rendering uses Rust. Native preview and export
median FPS exceed contemporaneous retained TS under G4, with M8 export quality and M11 latency
requirements satisfied. Every non-`exact` comparison has a passing `self_reviews` record and every
tolerance change is recorded within the hard floor.

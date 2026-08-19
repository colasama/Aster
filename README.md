# Aster

**GPU-first motion graphics and compositing, built for real-time iteration.**

Aster is an open motion design studio built with Rust, Tauri, React, and WebGPU/wgpu. Its core
model is time-addressable: project state can be evaluated at any time without replaying previous
frames. Rendering, effects, particles, and composition are designed to remain GPU-resident.

> Aster is under active development. The current vertical slice proves the editor shell, motion
> model, structured operations, project persistence, render graph, HDR WebGPU renderer, effect
> catalog, GPU particles, plugins, and guarded AI operation planning.

## Current capabilities

- AE-style desktop editor with dockable, movable, resizable panels and free viewport zoom/pan.
- Rational time, keyframes, cubic easing, graph view, layer ordering, undo/redo, and arbitrary-time
  evaluation.
- Arbitrary effect parameters—including numeric, color, toggle, and choice controls—support
  Inspector keyframing, distinct Timeline tracks and markers, direct retiming/removal, and GPU
  evaluation at render time.
- WebGPU high-performance adapter selection, `rgba16float` HDR composition, ACES output,
  timestamp-query profiling, 100,000 compute particles, and fused realtime effects.
- GPU image layers, time-addressable hardware-decoded video layers, recursive precompositions,
  depth-buffered 3D cubes/cameras, blend modes, parenting, solo, timing, and expressions.
- Retained GPU text textures participate in HDR layer effects, blend modes, precompositions, and
  lossless frame export.
- Full/Half/Quarter preview resolution, dual Active/Custom views, lossless 4K PNG frame export,
  cancellable native PNG sequence rendering with progress, local autosave recovery, and atomic
  native project persistence.
- Data-driven catalog of 115 blur, color, channel, distort, generate, stylize, keying, time,
  transition, simulation, matte, and Looks-style effects, including 113 ordered GPU opcodes.
- Professional channel and keying tools include Set Channels, Arithmetic, Alpha Levels, Remove
  Color Matting, Linear Color Key, Color Range, Matte Choker, and GPU Keylight.
- Sixteen one-click Looks chains with palette previews and transactional undo, complete Color Lab
  lift/pivot/gain controls, and stock-sensitive film emulation.
- Searchable Effects Browser with persistent favorites and a bounded recently-used GPU effect list.
- Persistent custom effect-chain presets capture ordered parameters, local masks, and parameter
  animation, then apply transactionally with fresh IDs and a single undo step.
- Inspector effect-chain reordering with undo; legacy grading, blur, glow, and Looks controls now
  execute as explicit ordered GPU operations instead of an out-of-band aggregate.
- Per-effect ellipse and rectangle masks run inside the ordered GPU chain for both spatial warps
  and pixel effects, with feather, opacity, inversion, undo, and project persistence.
- Bounded `.cube` import embedded in the project, uploaded as `rgba16float` 3D textures, with
  trilinear and tetrahedral GPU interpolation.
- Rust render graph with validation, topological scheduling, resource lifetimes, transient aliasing,
  and DOT/JSON diagnostics.
- Open project bundle, a native WGSL plugin manager with safe mode, permission-checked AI operation
  plans, and an OpenAI-compatible provider boundary with in-memory secrets.
- Browser compatibility renderer when WebGPU is unavailable.

## Architecture

```text
React/Tauri editor ── structured operations ── aster-core / aster-timeline
       │                                              │
       ├── WebGPU preview ── HDR graph/effects ── aster-render
       ├── project bundle ────────────────────── aster-project
       ├── plugin manifests ──────────────────── aster-plugin
       └── guarded operation plans ───────────── aster-ai
```

See [Architecture](docs/ARCHITECTURE.md), [Project Format](docs/PROJECT_FORMAT.md),
[Plugin Model](docs/PLUGINS.md), and [AI Operations](docs/AI_OPERATIONS.md).

## Build from source

Prerequisites: Node.js 22+, pnpm 10.15, Rust 1.97, and the platform prerequisites for Tauri 2.

```bash
pnpm install --frozen-lockfile
pnpm check:frontend
cargo test --workspace --all-features
pnpm tauri dev
```

For the browser editor only, run `pnpm dev`. Production assets are built with `pnpm build`.

## Quality gates

- `pnpm check` runs Biome, TypeScript, Vitest, rustfmt, Clippy with warnings denied, and Rust tests.
- lefthook applies the relevant gates before commits and pushes.
- `cargo deny check` enforces dependency source and license policy.
- Commits use gitmoji plus Conventional Commit intent, for example
  `✨ feat: add HDR effect fusion`.

## Security and privacy

AI changes are previews of typed operations and require explicit acceptance. Provider keys remain in
memory or environment variables and are never stored in project files. Embedded media is bounded by
import limits; do not open untrusted projects without reviewing their origin. See
[SECURITY.md](SECURITY.md).

## License

Aster is licensed under [MPL-2.0](LICENSE). Dependencies retain their respective licenses; see
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

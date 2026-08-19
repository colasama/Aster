# Architecture

Aster separates its portable model from platform/UI code. The Rust crates own deterministic domain
logic and native boundaries; the React/Tauri application owns interactive editing and the current
WebGPU preview implementation.

## Crates

| Crate | Responsibility |
| --- | --- |
| `aster-timeline` | Rational time/frame rates, interpolation, arbitrary-time properties |
| `aster-core` | Project model, dependency DAG, operations, transactions, undo/redo |
| `aster-scene` | Unified 2D/3D entities, cameras, lights, auxiliary buffers |
| `aster-render` | Adapter strategy, render graph, lifetimes, aliasing, debug export |
| `aster-profiler` | RAII CPU timing and rolling metrics |
| `aster-project` | Versioned bundle validation and atomic persistence |
| `aster-plugin` | Manifest, parameter, permission, and capability validation |
| `aster-ai` | Permission-checked operation planning, audit, provider boundary |

## Frame flow

1. UI gestures produce serializable operations; they do not mutate render state directly.
2. The operation reducer creates a new project snapshot and updates bounded undo history.
3. Properties and safe expressions are evaluated at the requested rational time; recursive
   precompositions are flattened with cycle detection and composed transforms. Effect parameters
   use the same time-addressable keyframe interpolation before uniform and opcode compilation.
4. Visible 2D/3D geometry, media textures, and effect uniforms are uploaded in batches. Mesh cubes
   carry clip depth and use the active camera transform plus a shared `depth24plus` target.
5. Compute particles run. Each effected layer uses a fused offscreen chain before its blend-mode
   composite; unaffected adjacent layers stay batched directly into the `rgba16float` scene target.
6. One composition-level ACES display pass presents the linear HDR result to the surface.
7. Metrics are sampled outside React's frame-critical path.

Frame and sequence export open one full-resolution render session, resize the GPU surface once, and
evaluate each frame directly from its timeline time. Native PNG sequences are written one frame at a
time through a restricted filename boundary and a same-directory temporary file, so cancellation is
bounded to the current frame and never leaves a partial PNG behind.

The preview has a Canvas 2D compatibility renderer. It is a functional fallback, not a performance
target. Native wgpu and browser WebGPU share formats and graph concepts, but do not yet share shader
compilation artifacts.

Layer effects reuse one pair of full-resolution HDR transient textures across the frame. Per-layer
uniform and operation buffers remain distinct so queue uploads cannot race command-buffer execution;
the large textures do not scale with the number of effected layers.

Text uses a retained raster cache: glyphs are shaped by the platform canvas only when text, color, or
source dimensions change, uploaded as an sRGB texture, and thereafter transformed, effected, blended,
precomposed, and exported by the same GPU path as image layers. Canvas 2D draws the same text model in
compatibility mode. A future native shaper/atlas can replace raster-cache creation without changing
the render graph.

Imported `.cube` resources are parsed through a bounded project boundary, stored in red-fastest
voxel order, packed to `rgba16float`, and cached per effected layer. The fused shader supports both
hardware trilinear sampling and explicit tetrahedral interpolation; layers without a LUT bind a tiny
identity texture so the pipeline layout stays stable.

Browser video uses hardware media decode and a persistent staging canvas before `queue.writeTexture`.
This deterministic compatibility path exists because current WebView implementations can silently
zero `copyExternalImageToTexture` for decoded video surfaces. The native video backend is expected to
replace it with platform-specific low-copy interop without changing layer or timeline semantics.

## Invariants

- Evaluation is a function of project state and time; playback history is never required.
- Dependency graphs reject cycles before scheduling.
- Project writes use a temporary file and recoverable backup replacement.
- AI and plugins act through declared permissions and typed operations.
- Cache data is derived state and never part of the source project.

## Performance strategy

Use GPU-resident intermediates, premultiplied alpha, HDR linear color, transient resource aliasing,
batched uploads, instancing, compute simulation, bounded history, and explicit instrumentation.
Optimize measured frame time; never hide semantic mutations inside render code.

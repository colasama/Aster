# Architecture

Aster separates its portable model from platform/UI code. The Rust crates own deterministic domain
logic and native boundaries; the React/Electron application owns interactive editing and the current
WebGPU preview implementation. Electron's sandboxed renderer reaches native capabilities only
through a context-isolated preload API, a main-process command allowlist, and the JSON-lines desktop
bridge. Local media uses a dedicated protocol whose path set is populated only by validated bridge
responses.

The desktop window uses renderer-owned chrome so the project menu and window controls share one
visual system. The frameless window exposes only minimize, maximize/restore, and close through the
context-isolated preload boundary; the renderer has no direct Electron access. The sandboxed preload
is emitted as CommonJS because Electron does not support ESM imports inside sandboxed preload scripts.

The main process also owns the versioned application preference store, single-instance/file-open
queue, display-clamped window state, unsaved-document close contract, and local diagnostic export.
Recovery autosaves remain distinct from primary project saves and are serialized with them so a stale
autosave cannot win a persistence race. See [Desktop application foundations](DESKTOP_FOUNDATIONS.md).

## Pi agent runtime

The desktop host runs Pi in an Electron utility process. Pi receives only Aster-owned meta-tools by
default; no global/project Pi resource discovery or coding tools are enabled. Tool calls are brokered
through context-isolated IPC to a renderer-owned application service that keeps a cloned,
revision-addressed edit workspace. Command batches are atomic, query/tool payloads are byte-bounded,
evaluation is time-addressed, and a submitted workspace can merge only when its live base revision is
still current. The merge is one regular editor transaction, preserving undo and command-log budgets.

Review and Agent modes expose only staged semantic commands. Full Access is created outside the Pi
tool surface through typed renderer confirmation plus an Electron native warning. Its grant is bound
to the renderer, project, model, provider host, and expiry. Only then does Pi receive bounded file,
process, network, plugin-management, project pack/unpack, and asset-link tools. Aster-native actions
reuse the validated desktop bridge; they do not fall back to shell parsing. Revocation, renderer loss,
or emergency stop aborts active privileged work. Provider credentials remain memory-only and never
enter tool or project audit records.

Agent preview requests reuse the renderer's bounded frame-session path against the cloned staged
project, capped to 384 pixels on the longest edge and 8 MiB of encoded PNG data. WebGPU readback stays
bounded; Canvas2D remains the compatibility path. Trusted model metadata controls whether Pi receives
native image content. Text-only models receive only secret-free pixel measurements and never gain a
visual-verification claim from those metrics.

## Logging and diagnostics

Renderer events cross a bounded, one-way preload IPC surface and join Electron lifecycle/export
events plus JSON `tracing` records from the Rust bridge. Electron adds a shared session ID and writes
the combined JSON Lines stream asynchronously to size-bounded rolling files. Command payloads and
frame data are excluded, and successful hot-path operations are intentionally silent. See
[`LOGGING.md`](LOGGING.md) for the schema, retention, privacy rules, and event-level guidance.

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
| `aster-desktop-bridge` | Electron sidecar protocol, native project I/O, and plugin runtime |

## Frame flow

1. UI gestures produce serializable operations; they do not mutate render state directly.
2. The operation reducer creates a new project snapshot and updates bounded undo history.
   Project-level footage sources are immutable shared records: operation snapshots copy only source
   arrays and affected records. Desktop footage stores a small runtime locator while its bytes move
   through the content-addressed project-media sidecar; legacy embedded locators remain shared during
   migration. Layers carry stable `sourceId` references, so duplication and ordinary edits never clone
   footage bytes.
3. Properties and safe expressions are evaluated at the requested rational time; recursive
   precompositions are flattened with cycle detection and composed transforms. Effect parameters
   use the same time-addressable keyframe interpolation before uniform and opcode compilation.
4. Visible 2D/3D geometry, media textures, and effect uniforms are uploaded in batches. Imported mesh
   vertices retain normal, UV, and tangent handedness for tangent-space normal mapping. Solid layers
   emit the ordinary six-vertex, untextured GPU quad using their dedicated bounded source settings,
   so transforms, 3D projection, effects, and blend modes reuse the standard render path without a
   texture allocation. Null layers are filtered before geometry and render-stack construction: they
   keep transform/parent/selection behavior but cannot allocate an effect surface or emit pixels.
   Media caches resolve layer instances through the project source registry; relink, reload, and
   interpretation replace one source record and invalidate consumers by stable identity.
   Radiance RGBE environments transfer to the bounded CPU worker pool, which validates every
   scanline and writes
   directly into the final row-aligned binary16 upload payload. The current environment-lighting
   prototype integrates five bounded cone samples for diffuse and rough specular response in linear
   space. It is prepared only for visible meshes in an environment-enabled composition. The material
   pipeline, fallback texels, and map uploads are created lazily only when a ready normal map or
   enabled environment needs them. Mesh cubes carry clip depth and use the active camera transform
   plus a shared `depth24plus` target.
5. Scene generators execute through the versioned plugin ABI. The host resolves a declarative graph,
   allocates quota-bounded GPU storage, packs standard frame/transform/camera and parameter uniforms,
   runs ordered compute phases, then issues plugin-selected indirect draws at the layer's stack
   position. The bundled particle generator uses exactly this path: its 256-thread analytic kernel
   evaluates emitter shape, velocity, gravity/drag, and turbulence and GPU-compacts visible records.
   No generated instance state crosses the CPU boundary. Per-slot state is deterministic for seed
   and layer-local time; atomic compaction order is deliberately unspecified. Missing plugins isolate
   only their nodes and preserve project data. Each effected layer uses a fused
   offscreen chain before its blend-mode composite; unaffected adjacent layers stay batched directly
   into the `rgba16float` scene target.

The generic layer factory requires an explicit plugin instance and the generic runtime receives
bundled definitions through constructor injection. Only application composition roots and the
bundled-particle adapter select particles as a convenient default; core layer creation, project I/O,
render-stack planning, precompilation, and GPU resource ownership contain no particle branch.
6. Beauty motion blur evaluates shutter-open and shutter-close geometry at exact timeline times,
   uploads one endpoint displacement per vertex, and rasterizes motion vectors with object IDs in the
   on-demand auxiliary MRT. A GPU tile-max, neighbor-max, and object-aware adaptive reconstruction
   writes a new premultiplied linear-HDR scene without consulting render history. Depth of field then
   consumes that scene and the world-position attachment. One composition-level ACES display pass
   presents the result. Beauty mode releases all motion/depth transient attachments when both effects
   are disabled, so the steady unblurred path pays no extra full-resolution VRAM.
7. Metrics are sampled outside React's frame-critical path.

Frame and sequence export open one full-resolution render session, resize the GPU surface once, and
evaluate each frame directly from its rational timeline time. Native PNG sequences are written one
frame at a time through a restricted filename boundary and a same-directory temporary file. The MVP
H.264 MP4 path copies the display-transformed canvas texture into three bounded WebGPU readback
buffers, transfers packed BGRA/RGBA frames through a dedicated binary Electron IPC surface, and
streams them into an FFmpeg child process. Audio is decoded once per shared footage source, mixed in
bounded one-second Float32 stereo chunks, hard-limited at the output boundary, and written to a
separate FFmpeg pipe for AAC muxing. The PCM frame count derives from the exact rational video frame
count so fractional rates do not accumulate A/V drift. Frames are submitted to the encoder in timeline order even
when GPU mappings finish out of order. A real one-frame probe selects NVENC when it works and otherwise
falls back to `libx264`; MP4 publication replaces the selected output only after FFmpeg writes the
trailer successfully. Compositions containing video layers, including nested compositions, use one
in-flight frame and wait for the browser decoder's `seeked` state before capture; graphics-only jobs
use all three readback slots. Cancellation stops at a bounded in-flight frame and removes temporary
output.

The preview has a Canvas 2D compatibility renderer. It is a functional fallback, not a performance
target. Native wgpu and browser WebGPU share formats and graph concepts, but do not yet share shader
compilation artifacts.

Viewport direct manipulation applies time-addressed preview operations while a pointer gesture is in
progress, so position, scale, rotation, and text changes render immediately. Releasing the pointer or
finishing text editing records one transaction from the gesture's original project snapshot, keeping
undo deterministic without accumulating per-move history entries. Canvas resizes invalidate the
preview, and renderer initialization always draws the current evaluated frame.

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
This deterministic compatibility path exists because Chromium implementations can silently
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

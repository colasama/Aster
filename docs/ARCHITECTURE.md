# Architecture

Production output supports shared, time-independent [anti-aliasing modes](ANTI_ALIASING.md): FXAA at
native resolution and SSAA with larger internal targets. The final GPU pass precedes canonical frame
readback; preferences and queued job snapshots carry the selected mode.

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

## Frontend source organization

Source folders follow ownership rather than a flat inventory of features. Tests stay beside the
code they exercise; consumers import the owning module directly instead of directory-wide barrels.

| Directory | Responsibility |
| --- | --- |
| `src/core/project/` | Project documents, compatibility, persistence, and bounded validation |
| `src/core/editing/` | Operation contracts, application, source guards, and layer property access |
| `src/core/animation/`, `audio/`, `media/`, `scene/`, `layers/` | Time evaluation and domain-specific models |
| `src/core/plugins/`, `scheduling/`, `rendering/` | Plugin contracts, CPU workers, and export/queue models |
| `src/effects/definitions/` | Color, spatial, compositing, generation, and stylization catalogs |
| `src/effects/presets/`, `browser/`, `resources/` | Presets, browser preferences, and LUT parsing |
| `src/renderer/effects/programs/`, `shaders/` | Effect compilation and GPU shader cases |
| `src/renderer/gpu/`, `scene/`, `compositing/`, `media/`, `text/`, `diagnostics/` | GPU services and rendering subsystems |
| `src/components/` | Feature folders for project, timeline, graph editor, inspector, viewport, settings, and shell |
| `src/workspace/` | Layout contracts, tree edits, normalization, and workspace persistence |

`project-file.ts` owns persistence orchestration. Its `validation/` modules validate document
structure, layers, text, sources, effects, and numeric/keyframe values without invoking desktop I/O.
`operations.ts` applies transactions; operation types, property access, and mutation guards live in
separate modules. Existing document fields, effect identifiers, and operation names remain stable.

`WebGpuRenderer` coordinates frame evaluation, passes, and lifecycle. `RendererResources` owns
allocation, resizing helpers, and disposal of its GPU resources and media/surface caches; scene batch
submission has its own module. Frame buffers remain GPU-resident until an explicit readback.
`ProjectPanel` owns project organization; `useProjectImports` owns import state and transactions, and
`EffectBrowser` owns presets and effect preferences. Its state survives tab changes while inactive
catalog rows remain unmounted. Viewport geometry and benchmark coordination are separate from the
viewer component. Styles are split by responsibility with their original rule order preserved.

## Editor interaction boundaries

Application, timeline, and workspace shortcuts share `isEditorShortcutBlocked`: consumed events,
IME composition, open modal dialogs, and open menus never fall through to background editing.
Keyframe keyboard operations use the same lock guards as their toolbar controls. Layer deletion
does not run while keyframes are selected, and layout undo remains distinct from project undo.

`AppMenuBar` owns menu dismissal, arrow navigation, and focus return. `CommandPalette` keeps input
focus while its combobox selects results with arrow keys; Enter executes one result and Escape
returns focus to the trigger. Dialog focus trapping excludes hidden, inert, disabled, and negative
tab-index controls.

Dock headers contain workspace tabs and actions. Embedded panel subtabs occupy their own scrollable
row; docked timeline surfaces do not duplicate the workspace's timeline/graph tabs. Each timeline
surface receives its own display mode. The application owns one playback hook regardless of how
many timeline panels are visible, so docking and closing panels do not own the audio clock.
Shared window pointer gestures cancel on Escape before background shortcuts process the key.

## Inspector property editing

Transform and numeric effect controls share `NumericInput`: horizontal scrubbing uses the property
step, Shift multiplies it by ten, and Alt divides it by ten. Clicking opens an exact-value draft;
Enter or blur commits valid input, while Escape discards it. Bounds apply to both pasted values and
dragging. Two-dimensional layers show X/Y vectors and Z rotation; 3D layers expose all axes.

Pointer previews are coalesced to one operation per animation frame. `useInspectorPropertyEdit`
uses the existing `previewOperation` and `historyBase` protocol to commit one undo transaction per
gesture. Keyframe IDs remain stable throughout the drag. Escape, pointer cancellation, window blur,
time changes, and control unmount cancel pending previews and restore the original property track.
Static properties stay static; animated properties are edited at the gesture's starting time.

The Inspector reads the whole layer selection. Shared fields display their current evaluated value
when it agrees across the selection, or an em dash when values differ. Checkboxes use their native
indeterminate state; selects and color controls expose the same mixed state. Entering a value assigns
that absolute value to every unlocked selected layer, including when it equals the first layer's
value. Merely focusing or leaving a mixed input never writes a zero or the placeholder.

`InspectorSelection` scopes the layer set to Inspector controls, so timeline row controls retain
their individual targets. Transform axes, text and shape settings, audio, blending, timing, motion
blur, cameras, lights, materials, generators, cloners, and shared effect parameters use field-level
updates that preserve each layer's other settings and animation tracks. Fields conditional on a
layer type or feature appear only when applicable to the entire selection. Effects match by type
and occurrence within that type; nested animator groups, selectors, and cloner effectors match by
ordinal with compatible kinds. Missing nested properties are omitted rather than created by an edit.
Text animation values use each layer's own source time. Batch transform and effect scrubs retain
per-target keyframe IDs and rollback tracks in one undo transaction; changing the selection also
cancels an in-progress edit.

## Scene lighting

The shared mesh material shader evaluates up to eight visible lights in flattened scene order.
Directional, point and spot lights retain their time-evaluated transforms, color, intensity, range
and cone. The first light retains the existing shadow map; the remaining lights add unshadowed
diffuse and specular illumination in the same GPU pass. A fixed 592-byte uniform replaces the former
144-byte single-light block. No extra render targets or CPU pixel transfers are required. Main
compositions, precompositions and scene generators share this material path. With zero additional
lights the shader skips the additional-light loop. Lights beyond the first eight do not contribute.

## Project fonts

Font rendering uses Chromium's shaping/rasterization. A dedicated editor-only preload call obtains
the native Local Font Access inventory; the main process runs a fixed enumeration expression and
permits `local-fonts` only for the editor window. MCP lists bounded font metadata, reads effective
text styles, patches selected style fields and imports bounded local font files. Imported bytes are
project resources, decoded before an undoable commit; no OS font installation occurs.
Project-owned `FontFace` instances are prepared asynchronously and activated for the project being
rendered. Preview and background export share this path. Decoded faces are reused across cloned
snapshots, with a 16 MiB source-byte cache; a font activation revision invalidates ordinary and motion
blur text textures. Enumeration, decoding and font bytes stay outside the steady-state frame loop.
The inspector uses a searchable, fixed-row virtual list with three overscan rows per edge.
Filtering does not mutate the project; selection or an explicit text commit changes the style.
Family sorting is memoized, and the inspector shares font enumeration for up to one minute.
The Rust `aster-text` file-discovery helpers remain available to native consumers; desktop rendering
does not require a second font parser or directory inventory.

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
   Multi-stop gradients share that chain: five packed RGB stops, endpoints, interpolation and blend
   fit one existing uniform operation. Time-addressable CPU evaluation sorts stops and interpolates
   color keyframes per channel; the GPU evaluates the ramp without sampling another texture or
   changing alpha. No project format version or plugin ABI layout change is required.
   SVG raster viewports keep their original layer aspect so geometry can apply nonuniform scaling;
   density follows the larger axis and reuses the existing bounded buckets. Text density includes
   evaluated parent scale in main and isolated surfaces, with the existing 8x raster cap.

The generic layer factory requires an explicit plugin instance and the generic runtime receives
bundled definitions through constructor injection. Only application composition roots and the
bundled-particle adapter select particles as a convenient default; core layer creation, project I/O,
render-stack planning, precompilation, and GPU resource ownership contain no particle branch.
6. Beauty motion blur evaluates shutter-open and shutter-close geometry at exact timeline times,
   uploads one endpoint displacement per vertex, and rasterizes motion vectors with object IDs in the
   on-demand auxiliary MRT. A GPU tile-max, neighbor-max, and object-aware adaptive reconstruction
   writes a new premultiplied linear-HDR scene without consulting render history. Depth of field then
   consumes that scene and the world-position attachment. One composition-level sRGB display pass
   presents the result. Beauty mode releases all motion/depth transient attachments when both effects
   are disabled, so the steady unblurred path pays no extra full-resolution VRAM.
   SDR output uses the IEC sRGB transfer on straight RGB, then restores premultiplied alpha. Imported
   sRGB images therefore retain their colors through linear compositing. HDR values remain available
   inside the scene and clip only at SDR output; filmic tone mapping is an explicit layer effect.
7. Metrics are sampled outside React's frame-critical path. Static timeline rows use a separate
   memoized document/selection context and row list, so clock and profiler updates do not reconcile
   every layer and marker. Expanded property values retain the sampled clock; gestures resolve
   current handlers and snap targets when they start.

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
falls back to `libx264`; both encoders receive the requested bounded bitrate through the same typed
export request. MP4 publication replaces the selected output only after FFmpeg writes the
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

Viewer navigation and chrome are separate from production frame evaluation. Preview targets use
composition pixel dimensions multiplied by full, half, or quarter preview quality, bounded by the
GPU texture limit. Zoom, panel size, and display DPI change CSS presentation without clearing the
canvas or reallocating render targets. Live Fit measures each
viewer's CSS container; free panning translates the centered stage, and wheel zoom preserves its
pointer or viewer-center anchor before paint. Snapshots use one bounded on-demand canvas copy, and ruler guides are
locally persisted viewing aids that feed the existing transform snap targets. Neither snapshots nor
guides modify project/export pixels. See [AE workflow audit](AE_WORKFLOW_AUDIT.md) for exact controls,
storage boundaries, and remaining feature gaps.
Layer-local geometry uses a top-left source space with an explicit anchor. GPU vertices, Canvas 2D,
selection outlines, picking, composition cropping, and inline text overlays all subtract the same
evaluated anchor before scale and rotation; newly created and migrated layers start centered.

Three-dimensional selection reuses the renderer's evaluated camera projection without a GPU
readback. Screen-space bounds are projected from bounded render quads or mesh boxes; the selected
layer's Local axes rotate with its evaluated transform while World axes remain composition-aligned.
Axis and view-plane drags write the animated Position property at the current time. Locked layers
remain selectable for inspection, but the overlay exposes no draggable surface or axis handles.

Layer effects and backdrop-dependent blend modes reuse one pair of full-resolution HDR transient
textures across the frame. After effect processing, the input surface becomes a backdrop snapshot for
alpha-correct blending; no third color surface or CPU readback is required. See
[layer effects and blending options](LAYER_STYLES.md) for kernel bounds and mode semantics. Per-layer
uniform and operation buffers remain distinct so queue uploads cannot race command-buffer execution;
the large textures do not scale with the number of effected layers.

Text uses a retained raster cache: glyphs are shaped by the platform canvas only when text, color, or
source dimensions change, uploaded as an sRGB texture, and thereafter transformed, effected, blended,
precomposed, and exported by the same GPU path as image layers. Canvas 2D draws the same text model in
compatibility mode. The paragraph box controls wrapping and alignment, while measured glyph ink
(including animator transforms, stroke, and blur) expands the raster and GPU quad without moving the
layer anchor. Text is neither clipped to the box nor horizontally squeezed to fit it. Temporal text
samples share the union of their local ink bounds, with texture density still capped by GPU limits
and the existing temporal memory budgets. Inline editing grows vertically around the same baseline.
A future native shaper/atlas can replace raster-cache creation without changing
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

The native `aster-render` graph assigns transient slots in first-use order. Descriptor-keyed
min-heaps select the earliest available compatible slot, with strict separation between lifetimes;
persistent resources never enter the alias pool. Allocation output remains ordered by resource
handle, while slot identifiers are derived compiler output. The native resource pool maintains
exact byte and lease totals on mutation so statistics and budget checks do not scan all entries.
These native utilities are separate from the current browser WebGPU preview implementation.

## External automation (0.2.1)

The external MCP stdio adapter forwards token-free loopback requests to the running Electron
application. Its shared tool definitions and renderer connection reuse `AsterAgentApplicationService`
for staged edits; explicit commits pass through the editor's undo transaction path. Reference
FFmpeg/FFprobe decoding runs outside the renderer, while bounded high-resolution previews and
comparison readbacks reuse the active render session. Import, save and export reuse their existing
application services. See [External Automation](AUTOMATION.md) for setup, budgets and authority.

Exact-frame export barriers observe asynchronous GPU video-upload validation as well as media
element events, so hidden render hosts do not depend on another preview tick. MP4 inputs signal EOF
as soon as their declared video/audio frame counts are written, allowing FFmpeg to finish probing
short clips without waiting on the other input. Frame failures propagate immediately to host cleanup,
which closes encoder pipes and releases any blocked audio write.

The Preferences MCP section manages the listener through primary-window-only IPC. The main process
owns the enabled/port preferences, clipboard configuration export and listener lifecycle.
Changes apply immediately; a failed reconfiguration restores the previous listener. Environment-based
launch configuration remains an explicit read-only override. The listener trusts local processes
and rejects browser requests. `aster-mcp --background` owns an isolated hidden editor,
ephemeral port and temporary profile; closing stdio shuts down that editor and removes the profile.
Interactive connections use `aster-mcp` and leave the user-owned editor running.
`shape.morph` uses the shared time-addressable path evaluator before adaptive vector tessellation; playback presentation uses the window clock channel independently of sampled React UI updates. See [Path morph](PATH_MORPH.md) and [Playback performance](PLAYBACK_PERFORMANCE.md).

2D precompositions with enabled wrapper effects reuse the bounded GPU surface path, allowing group
alpha masks and silhouettes without CPU rasterization. Render-stack entries retain local evaluation
time for effects across nested and retimed compositions. See [Semantic vector compositing](SEMANTIC_VECTOR_COMPOSITING.md)
for the isolation rules, anchor and reflection corrections, and validation method. Flattened 2D
wrappers apply animated anchor offsets before source-size mapping, preserving their GPU corners
when effects are toggled. Analytic shape edges use screen-space distance derivatives so a large
iris retains a pixel-sized antialiasing footprint without another render pass.

The built-in linear wipe can curve its alpha boundary without warping the source texture. Its
optional amplitude, wavelength, phase, and phase speed occupy unused slots in the existing GPU
operation; enabled bends add one sine in the pixel pass and require no additional surface or pass.
See [Semantic vector compositing](SEMANTIC_VECTOR_COMPOSITING.md) for parameter and validation details.

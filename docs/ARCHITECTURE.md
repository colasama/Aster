# Architecture

Production output supports shared, time-independent [anti-aliasing modes](ANTI_ALIASING.md): FXAA at
native resolution and SSAA with larger internal targets. The final GPU pass precedes canonical frame
readback; preferences and queued job snapshots carry the selected mode.

GPU selection defaults to high performance. The persisted high-performance/low-power preference
configures Electron before GPU process startup and WebGPU adapter requests for preview, export,
and memory detection. Changes apply after application restart; platform GPU selection remains
authoritative. See [desktop preferences](DESKTOP_FOUNDATIONS.md).

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

Timeline layer translation uses the core `moveLayer` operation, separate from `setLayerTiming`
trimming. The layer-animation collector includes operation-addressable properties, effect tracks
and time remapping. Pointer-down captures owned keys; drag previews translate markers and bars
without changing the document. Pointer-up commits the selected group as one undo transaction.
Moving layers exclude their own keyframes from magnetic snap targets. Keyboard alignment uses
the same timing solver and operation builder. Evaluation remains time-addressable.

Playback-head scrubbing owns a cancellable animation-frame edge-scroll loop. Its speed ramps to
720 pixels/second within 48 pixels of either track edge, excluding the fixed property column.
Each scroll recomputes the seek from the current viewport; a stationary pointer continues seeking.
Release, Escape, cancellation, blur, composition changes, hidden panels and unmount stop the loop.
Keyboard time navigation reveals the requested time with a 48-pixel margin; ordinary playback and
manual viewport scrolling do not activate this navigation behavior.

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
| `src/renderer/effects/programs/` | CPU effect-program compilation |
| `src/renderer/gpu/`, `scene/`, `compositing/`, `media/`, `text/`, `diagnostics/` | GPU services and rendering subsystems |
| `shaders/` | Shared WGSL and declarative program manifest for the renderer and generator/audio ABI helpers |
| `src/components/` | Feature folders for project, timeline, graph editor, inspector, viewport, settings, and shell |
| `src/workspace/` | Layout contracts, tree edits, normalization, and workspace persistence |

`project-file.ts` owns persistence orchestration. Its `validation/` modules validate document
structure, layers, text, sources, effects, and numeric/keyframe values without invoking desktop I/O.
`operations.ts` applies transactions; operation types, property access, and mutation guards live in
separate modules. Existing document fields, effect identifiers, and operation names remain stable.

`WebGpuRenderer` coordinates frame evaluation, passes, and lifecycle. `RendererResources` owns
allocation, resizing helpers, and disposal of its GPU resources and media/surface caches; scene batch
submission has its own module. Frame buffers remain GPU-resident until an explicit readback.

`aster-renderer` executes validated supplied frame bundles on a headless native wgpu device.
Its initial capability covers solid/vector draws, fixed and backdrop blends, display conversion
and all four AA modes. It consumes shared WGSL and exact supplied geometry, lighting, clear and
post-process buffers; it does not evaluate projects or open media paths. Unsupported operations
return explicit errors before rendering. Images, masks, adjustments and recursive surfaces remain
pending native capabilities, and production preview/export still use the TS execution path.

Linear HDR scene and isolated layer intermediates stay on the GPU. Frame targets are reused by
extent under a configured allocation budget; a returned frame leases its output until released,
preventing reuse while a consumer still owns it. `aster-render-cli render-plan` uses an explicit
diagnostic readback to publish a PNG atomically. Future preview and encoder consumers use the GPU
texture directly. The CLI verifies the exact content-addressed resource closure before execution
and reports adapter identity and input/output hashes for independent pixel verification.

The migration's `aster-render-ir` crate owns typed frame-plan transport and its generated schema.
TS DataView and Rust owned-buffer codecs share a canonical FPLN container with aligned binary blobs
and separate content-addressed resource operations. The initial contract carries an explicit
partial post-process uniform slice. Production root post-processing now builds this slice from exact
request time and caller snapshot identity, then uploads the supplied bytes through a separate
executor. An additional owned scene-buffer slice carries evaluated camera-space vertices, lighting,
motion vectors and stable-ID draw ranges. The root renderer uploads these supplied buffers and uses
their ranges for beauty, auxiliary and shadow draws. Material/resource adapters still retain live
layer inputs. A separate camera slice owns exact evaluated pose, projection and optics; root geometry,
lighting, depth settings and generator preparation consume its decoded values without authoring settings.
Complete depth/pass planning and frame replay remain separate
milestone requirement. See [Frame-plan transport](migration/FRAME_PLAN.md).

Root image/video drawing and auxiliary passes now acquire an explicit per-frame media binding
lease after readiness checks. Source/frame generation changes are rejected during binding resolution;
cache replacement retires owners, with destruction deferred until all submitted leases complete on
the GPU queue. Unsubmitted failures release their leases immediately. These runtime handles remain
outside FPLN. Shared TS/Rust transport registries now accept content-addressed media source/frame
descriptors, preserving exact video times and sequence frame numbers with dependency-aware eviction.
Root media preparation now produces those descriptors and assigns content hashes to beauty/auxiliary
draws. A persistent GPU registry validates descriptor hashes against installed bindings, bounds
metadata and physical-owner residency, and retains replaced in-flight owners until queue completion.
Frame leases resolve hashes through a private lookup; source dependencies prevent premature eviction.
Registry eviction unregisters bindings while the media cache remains the allocation owner. Cache
accounting includes retired owners still referenced by submitted frames, without double-counting
current owners. The scene slice now carries ordered draw-index media references with explicit pending
states and frame hashes included in the plan resource table. Root preparation builds these references
after readiness and resolves the supplied plan before encoding. TS/Rust FPLN preserves them exactly;
authorized native media resolution and full captured-frame replay remain pending.

Ordinary text raster acquisition now owns sampled-time evaluation, font revision, raster density and
glyph-state reuse. A separate GPU consumer receives the prepared canvas, extent and copied ink bounds;
it does not read a Layer or rerun text evaluation. Root text geometry and shutter samples use captured
bound maps, preserving shared-instance preparation and precomposition ordering. Canvas pixels stay on
the GPU-backed upload path. Ordinary text registers a typed raster sample with exact ink bounds and
font/source generation identity. Its scene draw resolves the serialized resource hash through a GPU
lease, including auxiliary draws. Reused glyph pixels retain their installed generation even when
the animation lookup time advances. SVG preparation freezes the bucketed target and source revision;
PSD preparation freezes the decoded plane's crop, row layout and document/layer identity. Both now
register raster descriptors. A shared upload consumer receives prepared bitmap or RGBA pixels,
validates their extent/layout, and releases failed allocations without publishing partial owners.
Root temporal text preparation now consumes a typed sample slice per resource instance. Exact
local times, weights, transparent exposure and exposure-only identities survive TS/Rust transport;
the temporal raster cache consumes the reconstructed samples. CPU preparation freezes expanded
bounds, budget-selected resolution, copied samples and generation identity, then acquires every
canvas before cache ownership changes. A separate GPU consumer uploads only those supplied canvases
without accessing authoring layers or text evaluators. Individual samples now have raster resource
identities. A separate pass executor resolves supplied sample/output hashes and writes supplied
weights before encoding accumulation and resolve. Submission-scoped leases retain these resources
until submission or abort. A closed FPLN slice now carries the ordered hashes, dimensions, formats
and exact f64 exposure weights through Rust. Production root encoding supplies its frame header and
executes the reconstructed slice. The diagnostic GPU gate captures actual sample textures and the
encoded pass, round-trips the pass through Rust, destroys the original device/page, and executes
decoded pixels in independent GPU allocations without authoring inputs. Full, entering, exiting and
transparent exposures must exactly match frozen outputs.
Resolved temporal outputs now use the same raster identities and planned scene bindings as ordinary
text. Cache and frame leases share their physical owner, delaying destruction until the last lease
releases it. Replacements preserve pinned outputs and count retired allocations against the temporal
resident budget; unpinned outputs of matching dimensions remain reusable.
The shared resource protocol also carries content-addressed, packed raster pixel payloads with
frame/source dependencies. An independent decoded upload consumer installs them without text/SVG/PSD
evaluation and verifies the requested authorization scope. The parity harness now explicitly captures
installed text/SVG/PSD textures, including resolved temporal text, uploads their decoded resources into independent GPU allocations,
and compares packed readbacks exactly. Captures deduplicate raster generations within each case and
retain binary evidence with per-frame references. Ordinary preview does not invoke raster readback.
This installed-resource audit is separate from the temporal sample/pass replay described above.
Complete submitted-frame plan capture and replay remain under extraction.

Packed `texture_pixels` resources carry explicit 2D/3D dimensions and linear RGBA8 or RGBA16F
formats. Descriptor and little-endian pixel bytes share one content hash validated by TS and Rust.
LUT and HDR preparation own packed half-float pixels; HDR preparation removes decoder row padding
without changing channel bits. The GPU uploader consumes only supplied resources and rejects
hash/layout/device-limit mismatches before allocation. Material preparation snapshots scalar
settings and ready texture hashes on each geometry batch. Drawing resolves registered normal/HDR
owners by hash without authoring lookups. Retiring any duplicate owner invalidates cached bindings;
another identical owner remains usable until the last owner retires. Normal acquisition supplies
bounded encoded PNG/JPEG/WebP resources to an independent decode/upload consumer, preserving linear
RGBA8 and disabled color-space conversion. Material bindings use a closed FPLN slice with tagged
normal/environment hash references and three little-endian binary64 scalars. Production drawing
consumes the decoded binding; conversion to float32 happens only at uniform upload. Root and
precomposition effect paths prepare owned LUT selections before command encoding. Selection keeps
the last enabled loaded LUT and its source-key invalidation policy; execution consumes supplied
content-addressed packed pixels without consulting the layer's LUT resource. GPU replacement is
atomic and stale owners are destroyed. Material GPU bindings now consume supplied scalar/hash plans
and registered texture owners independently of acquisition. Six frozen RGBA16F material draws are
replayed on a new device from Rust-returned scene/material plans and normal/HDR resources. Root and precomposition effect execution now consumes supplied effect FPLN, including compiled
instructions, uniforms, blend/route controls, pyramid needs and selected LUT hashes. Six frozen
LUT/effect draws replay on an independent device after Rust transport. Effect execution routing also travels through FPLN: root and precomposition consumers read supplied
isolation, composite and fusion decisions, including direct and skipped instances. Whole-frame pass
planning and capture remain under extraction. Root scene ordering now snapshots only instance IDs,
geometry draw indices and depth transitions after media/material preparation. Geometry execution
consumes owned draw ranges, blend modes, texture references and material values without retaining
authoring layers. Pending media retains the shape fallback; unavailable precomposition surfaces
remain omitted. Root preparation emits an ordered command stream for scene attachment load/store,
depth clears, geometry/generator draws, isolated inputs/composites and adjustment operations. The
root executor consumes that stream without rediscovering pass boundaries or supplying draw
callbacks. Layer effects expose paired input/completion operations; the legacy precomposition
adapter retains callback compatibility. The root command FPLN contract carries ordered commands,
geometry ranges, texture references, and linked material/effect slices. Clear values retain binary64
bits in a dedicated payload. TS and Rust validate pass nesting, draw identities and dependency
types; production executes the decoded command data. Four root-stack fixtures replay on a fresh
GPU device from Rust-returned scene, command and effect plans, exactly matching a frozen
pre-command loop. Draw deletion/reordering, depth-load changes and adjustment removal must
change real pixels. This verifies root orchestration; generator payloads, recursively produced
surfaces and whole-frame capture remain under extraction.
Generator preparation now produces owned context, parameter, indirect and root-time audio payloads
plus explicit compute dispatches. Executable program snapshots reference content-addressed WGSL
resources and carry compute/render/auxiliary entry points, depth, cull and blend descriptors.
Bundled and installed generators enter the same shader validation boundary. GPU realization reads
only supplied plans; authoring lookup, time mapping, variant selection and LOD remain in the
producer. Allocation failure can bound the supplied count to retained storage without mutating
its plan. The generator FPLN slice now transports executable metadata and packed context, parameters,
indirect initialization and optional audio through Rust. Production root and precomposition
adapters execute decoded inputs; G1 verifies exact payloads and supplied execution. G3 additionally
round-trips eight invocation plans and four shader resources through Rust, then replays seven
particle, cloner and installed audio-plugin cases on an independent device. Outputs exactly match
frozen pre-extraction host captures; fifteen deliberate compute/context/audio/clone mutations must
visibly change pixels. Complete frame capture remains pending.

Precomposition jobs now own scene-buffer FPLN data, copied effect and generator payloads,
draw references and explicit pass commands. They address output and child surfaces by target ID;
GPU entries and prepared generators remain in execution-owned maps. Encoding no longer reads
`Composition`, `Layer` or `GeometryBatch`. The existing child-first traversal, cache sharing,
current-frame eviction protection, limits and generator failure diagnostics remain at the
preparation boundary. Child media addresses resolve to content hashes before command-encoder
creation. Root and child scenes share one frame lease, keeping media owners alive through GPU
submission. Executable child draws and their scene-buffer FPLN slices carry matching hash/pending
references, preflighted before drawing. The target graph has a bounded FPLN contract shared with
Rust: child-first target descriptors, explicit shared aliases and per-draw surface routing.
Validators reject cycles, missing alias targets and inconsistent cache accounting.
A content-addressed bundle now carries that graph with child scene/command/effect/generator FPLN,
LUT pixels, shader bytes and media source/frame descriptors. Decoding validates hashes, dependency
closure, frame identities and geometry/media/command cross-references. Production consumes the
decoded scene buffers and generator invocations for GPU uploads. G1 round-trips both the bundle
and embedded FPLN through Rust and checks all resource messages at the Rust registry boundary.
Media pixels remain owned by the shared frame lease. Recursive source-time evaluation, shared
aliases, target budgeting, text shutter samples and ordered media requests are computed before
GPU allocation. The CPU geometry evaluator consumes child layers and supplied raster bounds.
The renderer realizes the ordered preparation operations, retaining cache pinning and child-first
execution. Nested generator planning performs no preliminary GPU realization. After bundle
validation, each invocation is realized once from decoded bytes; the bundle also preserves the
layer/plugin diagnostic origin. Explicit realization failures omit the generator draw and any
otherwise-empty isolated effect pass, retaining attachment clears and other draws. Missing
realization records remain errors before GPU encoding. A consumer can allocate targets and realize
an owned bundle without an authoring media cache or source evaluation. Both production planning and
supplied-bundle execution use the same decoded scene/generator upload boundary. Supplied bundles
validate target identity, device dimensions and memory limits before allocation; all retained targets
in the incoming frame are pinned before any entry can be recycled. G3 replays six recursive
surface cases on independent devices after Rust transport, matching frozen pre-extraction surface
execution exactly. Shared targets, child-first order, isolated effects, adjustments and generator
success/failure are covered, including a retained-target pinning challenge and eleven visible command or pixel mutations. The suite transports 60 FPLN packets
and 59 resources. Capture reads installed image, video or raster pixels through the retained frame
lease, preserving its exact frame identity and sRGB sampling. The bundle links each media frame to
an owned packed byte resource; validation rejects duplicate frames, unreferenced frames, mismatched
extents and corrupt payloads. Independent replay rebuilds bindings from these bytes without media
decoders. Ordinary preview keeps media GPU-resident. Recursive capture binds observed generator
availability, allocation capacity and effective instance counts to the exact supplied scene generation.
Replay skips captured unavailable generators even on a healthy host, constrains successful invocations
to their observed capacity, and rejects a consumer that cannot reproduce the captured count. The
failure GPU case uses a healthy replay host, so omission is driven by transported data. Complete
root-frame capture includes these recursive snapshots and their retained media generations.


The final output route is a typed FPLN slice selecting scene or motion-blurred beauty, a depth or
surface effect, or a specific diagnostic buffer view. Planning resolves availability fallbacks;
encoding consumes only the supplied route, clear color and header AA mode. It rejects missing
motion-blur bindings and mismatched AA allocation generations before starting the output pass.
The G1 transport gate covers all view modes and four AA modes through Rust and the supplied executor.
Motion reconstruction has a separate typed FPLN slice with exact shutter timing, ordered attachment
roles, the observed ready/skipped decision, and owned mixed f32/u32 GPU uniform bytes. The existing
tile-max, neighbor-max and HDR reconstruction passes consume those bytes without consulting mutable
settings. Missing attachments or mismatched dimensions fail before GPU recording; captured skips
remain skips even if resources become available. G1 exercises Rust transport and supplied execution,
including malformed uniform rejection. Depth and surface effects also transport owned GPU uniforms,
the selected object ID, observed availability, and ordered attachment roles. Depth fallback choices
are explicit: replay retains a captured world-position or scene fallback even when additional
attachments exist. Final output checks the effect kind, mode and complete frame header, then
prepares the supplied effect before opening its render pass. Missing planned attachments and stale
dimensions fail without recording that pass. Auxiliary MRT plans carry the observed unavailable,
cleared or drawn outcome, transparency tier, ordered geometry and generator identities, texture
resource roles, and owned object/material IDs and motion vectors. The executor resolves the supplied
resource closure before writes or passes and preserves captured fallbacks on a healthier replay
device. Empty payloads use four zero bytes to retain the nonempty FPLN blob invariant. G1 checks
transport and supplied command execution. G3 also round-trips scene/auxiliary plans and texture
resources through Rust, replays them on a separate GPU device, and compares every auxiliary
attachment against a pinned pre-extraction executor. Draw, ID, motion, texture, transparency and
clear mutations must visibly change the relevant surfaces. A separate generator auxiliary suite
transports particle compute/draw plans and shader resources, compares every MRT attachment against
the retained host and auxiliary executors, and checks compute, draw and object-ID mutations. A
plugin without an auxiliary shader retains its empty contribution and rejects an invented draw.
Combined output replay transports motion, depth/surface and final-route plans through Rust and
executes them on a separate GPU device. Twenty-three cases cover all diagnostic modes, four AA
modes, motion followed by depth of field, and transparent attachment fallbacks. Pinned retained
executors supply the reference pixels; route, effect-uniform and motion-radius mutations must
change visible output even when live settings are poisoned. Integer diagnostic views bind only
their declared texture, and their colors are independently checked against the WGSL ID hash.
Complete root-frame capture and production cutover remain open.

Root rendering now resolves auxiliary availability, motion reconstruction, depth-source selection
and final output before creating the command encoder. `recordPlannedFrame` records supplied scene,
shadow, recursive surface, generator and output work through one entry point. Output stages share
a checked frame identity and reject inconsistent effect coverage or skipped motion dependencies
before GPU recording. A typed `frame_bundle_slice_v1` now groups the root scene, ordered commands,
post uniforms, auxiliary/motion/output stages, effect/LUT programs and generator invocations by
content hash. It includes observed shadow allocation and recursive bundles with generator outcomes.
Material acquisition retains encoded normal maps and HDR pixel payloads until their GPU owners are
retired; assembling the bundle requires no material GPU readback. Production recording decodes the
bundle, uploads its supplied bytes and uses its effect and generator inputs. Root and recursive
bundles share program serialization and dependency validation. G1 transports the envelope, nested
FPLN and resource messages through Rust. Production media descriptors resolve through live GPU
leases; auxiliary bindings and recursive targets are prepared from supplied plans.
Diagnostic frame readback now captures the media pixels used by the submitted root and recursive
plans. Content-addressed pixel links are part of the typed frame envelope and validated in TS and
Rust; a complete capture must cover each declared media frame exactly once. An independent lease
keeps those texture generations alive after the normal submission lease releases. Normal preview
and export do not request this diagnostic readback. The parity capture path exercises the submitted
bundle after FPLN encoding and decoding on every captured frame. A separate headless GPU device
reconstructs media and material registries, recursive surfaces, generator workloads and auxiliary
bindings solely from the decoded bundle. Each captured candidate is this replay's output, accepted
only after byte-for-byte comparison with the original production frame. Supplied texture owners
remain alive until readback completes; missing dependencies and authoring raster-cache aliases fail
replay. Resource limits apply independently of authoring preferences.
Capture metadata records both pixel hashes for this comparison. A mismatch preserves both lossless
images and its byte-difference report in the run directory before rejecting frame publication.
Large capture payloads use browser-native asynchronous SHA-256 with owned inputs; they retain the
same content-hash and layout checks as synchronous decoding. Video and placeholder allocations allow
copy-source access so capture reads the installed texture rather than decoding a replacement frame.
Pending temporal text passes are planned before command recording and included as nested FPLN
resources in the frame envelope. Sample hashes, exposure weights and output formats travel with
leased sample generations. Supplied replay allocates blank derived outputs instead of uploading
their captured resolved pixels, then executes the shared linear accumulation and sRGB resolve
passes before scene drawing. Frame metadata records replayed temporal pass and sample counts.
Diagnostic bundle capture reconstructs unchanged temporal generations during raster preparation,
so warm-up cache hits still expose their actual submitted sample passes. Normal preview/export keep
their existing cache reuse. Each captured address retains the actual submitted `plan.fpln`, a replay
envelope with installed media pixels, all content-addressed resources, and the Rust admission report.
Before independent TS replay, Rust validates resource hashes, nested plans and the unchanged submitted
execution, then re-encodes the replay envelope exactly. Capture publication and M2 verification audit
these artifacts for every frame, including sequence neighbors. Root bundles declare a complete
renderer plan, while partial stage contracts remain incomplete. The M2 exit auditor binds the
current full correctness gates to this capture evidence and the reviewed execution boundary.
Native GPU execution remains a separate capability to be implemented by the native renderer.

Root and auxiliary draw contracts accept content-addressed media or planned surface references;
instance-based raster-cache aliases are rejected at the transport boundary. Vector text retains
its geometry-only path. Two isolated precomposition levels exercise warmed temporal sample replay
and exposure mutations through the same frame-owned resource lease.

Shared WGSL includes output anti-aliasing, core scene variants, compositing, fused post-processing,
blur/depth/surface effects, auxiliary surfaces, particles, text motion blur and display/buffer helpers.
The TS `SharedShaderCatalog` loads sources through Vite `?raw`, including in Vitest, and concatenates the fragments in
`shaders/manifest.json` order without inserting separators. The `aster-shaders` crate
embeds the same files with `include_str!`, follows that manifest, and validates the assembled programs
with Naga. The manifest declares entry points and typed override defaults; pipeline constants use
those declarations and validate caller-supplied values. Fixed unsigned integers can appear between
fragments when they define shader-creation layouts; the seven additional-light slots are declared
once in the manifest and also determine the TS uniform allocation. An override cannot size this
uniform struct array. Material variants select fixed fragment sequences, and helper modules declare
an empty entry-point list. Naga checks their actual declarations as well as complete programs.
Output AA retains its existing `scale` override; compositing retains `blend_mode`. Motion blur uses
the `tile_extent` override for its existing 16-pixel tile algorithm, with the same manifest default
controlling host texture dimensions and all three fragment pipelines. Depth and surface effects
reuse the shared sRGB transfer fragment. The fused post-process recipe also reuses that fragment and
orders the warp cases, pixel cases and dependent helpers in one complete program. Case fragments
are not standalone modules; Naga validates their assembled bindings, control flow and entry points.
Shader extraction preserves the original expanded bytes, including operation order, effect masks,
time mutation, sampling and alpha handling.
The root post-process pipeline uses the `root_zero_operations` specialization after its plan
executor validates a zero operation count. Layer effects retain the dynamic default. This removes
unreachable root effect loops at pipeline creation while keeping all supplied base-effect uniforms,
sampling, grading, display expressions and resource bindings intact.

Particle compute and render programs share the scene-generator ABI and projection fragments.
Their storage layout, indirect draw data, visibility handling and 256-thread compute workgroup are
unchanged. The audio ABI is a single raw WGSL file that the CPU audio module can import without
loading the renderer catalog. Its fixed array lengths preserve the 9280-byte ABI v1 layout and are
checked against host packing and native validation. External plugin shader modules remain complete
validated sources supplied by the plugin runtime; they are not rewritten by the shared catalog.
An AST-based source check rejects inline WGSL implementations in `src/`, including test fixtures.
Rust tests verify that disk sources, embedded sources and manifest coverage agree before validating
the assembled programs.

Renderer migration verification uses the CPU-only `aster-render-compare` crate behind the thin
`aster-render-cli compare` command. It reads lossless reference and candidate PNGs without changing
color values, evaluates fixed numeric and structural limits, and atomically publishes diagnostic
images and reports. The production GPU path does not depend on this offline oracle. Its phase
correlation uses RustFFT behind an Aster-owned interface; ambiguous registration fails closed.
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
permits `local-fonts` and `clipboard-sanitized-write` only for the editor window; installing
permission handlers denies every unlisted renderer permission, so clipboard writes must be
explicitly allowed. MCP lists bounded font metadata, reads effective
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
| `aster-shaders` | Embedded shared WGSL, manifest assembly, entry points, overrides, and Naga validation |
| `aster-render` | Adapter strategy, render graph, lifetimes, aliasing, debug export |
| `aster-render-ir` | Typed frame plans, recursive resource closure and bounded transport validation |
| `aster-renderer` | Native wgpu execution of supplied frame plans with explicit capability rejection |
| `aster-render-cli` | Headless plan rendering, transport diagnostics and image comparison |
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
   Each flattening call indexes parent layers and memoizes world transforms per composition and exact
   source time, including repeated precomposition instances. The memo is discarded after that call,
   so arbitrary-time evaluation and in-place edits cannot inherit another frame's transforms.
   Bezier subdivision, fill triangulation and stroke tessellation use a shared content-keyed LRU
   (128 entries, 8 MiB estimated CPU memory). Keys include evaluated control points, closed topology,
   exact signed stroke dimensions, width, trim, joins and caps; paint and camera/world transforms
   remain evaluated per frame. Vertex attributes are written directly into Float32 storage, grown
   per geometry batch and trimmed before retention/upload, avoiding large intermediate JS arrays.
   Camera basis and projection constants are prepared lazily at the first 3D vertex and reused for
   the rest of that geometry build. Each build owns its projector, so camera edits and arbitrary-time
   evaluation cannot reuse stale camera data; pure 2D geometry never prepares a camera.
4. Visible 2D/3D geometry, media textures, and effect uniforms are uploaded in batches. Imported mesh
   vertices retain normal, UV, and tangent handedness for tangent-space normal mapping. Solid layers
   emit the ordinary six-vertex, untextured GPU quad using their dedicated bounded source settings,
   so transforms, 3D projection, effects, and blend modes reuse the standard render path without a
   texture allocation. Null layers are filtered before geometry and render-stack construction: they
   keep transform/parent/selection behavior but cannot allocate an effect surface or emit pixels.
   Media caches resolve layer instances through the project source registry; relink, reload, and
   interpretation replace one source record and invalidate consumers by stable identity.
   Preview presentation never draws a pending media generation: `MediaTextureCache.mediaReady`
   reports unresolved fetches, decodes, and first video uploads per instance, and both renderers
   hold the previously submitted frame until every visible instance is ready, so loading media
   cannot flash a layer-color quad or a transparent rect. During playback a held frame stalls the
   clock: `publishPlaybackFrame` reports it synchronously, audio pauses, and playback resumes from
   that frame once it presents (a frame that stays pending for 10 s stops stalling the session).
   Imports and document changes warm a bounded still-image decode pool (`raster-image-prefetch.ts`,
   2 workers, 24 entries) with the earliest-used stills, each locator at most once, so the pool
   drains instead of re-queueing evicted images; a renderer request for a warm that has not started
   cancels it and decodes immediately. During playback the renderer also flattens the scene one
   lookahead window ahead to prepare arriving media.
   Finished beauty frames are kept in a RAM preview cache (`core/rendering/preview-frame-cache.ts`,
   default 2048 MiB, set in Preferences; 0 disables it). A scope names every frame input except its
   index: the immutable project and composition objects, preview size, anti-aliasing, plugin
   registries, and font activation, so any edit starts a new scope and the first lookup drops the
   composition's stale frames. With the cache enabled, playback snaps to composition frames (as
   export does) and a paused off-frame time renders exactly without caching. A cache hit writes
   the stored pixels straight into the canvas texture; a miss renders and arms a readback from a
   dedicated pool that is kept only if the frame was complete (every visible media instance
   exact, materials and audio analysis settled, no missing generator), so a replayed frame always
   equals a fresh render. The timeline ruler draws cached runs for the active scope.
   While paused, `PreviewPrerenderer` fills the cache in idle time from just after the playhead to
   the work-area end, then from its start: each frame renders through the same pipeline with a
   capture armed, and the displayed frame is written back in the same task, so the viewport never
   changes. A frame held for loading media is retried after the exact-frame barrier settles; other
   incomplete frames are left to live preview. The job's window is sized to the budget and its
   cached frames are touched as it passes them, so eviction only removes frames outside it. Seeking,
   playback, edits, and preview size or AA changes cancel the job; media repaints do not.
   Export capture still submits its incomplete discovery frame offscreen, then waits and
   recaptures through the exact-frame barrier.
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
   evaluates emitter shape, velocity, gravity/drag, and turbulence into stable source-index slots.
   No generated instance state crosses the CPU boundary. State and draw order are deterministic for
   seed and layer-local time. Every slot carries a visibility bit; culled instances exit the vertex
   stage with clipped, degenerate geometry. This avoids scheduler-dependent blend rounding and
   transparent-mesh depth occlusion. The indirect count includes all budgeted instances, so invisible
   particles still incur the vertex visibility check. Missing plugins isolate
   only their nodes and preserve project data. Each effected layer uses a fused
   offscreen chain before its blend-mode composite; unaffected adjacent layers stay batched directly
   into the `rgba16float` scene target.
   Blur-dependent operations gather from a Kawase-filtered downsample pyramid built once per effect
   layer: the shader maps blur radius onto mip LOD and takes a bounded ring of taps, so arbitrary
   radii stay constant-cost while small radii keep a direct nine-tap kernel on the source.
   Fast Bokeh reuses that pyramid for depth-driven defocus: a signed circle-of-confusion per pixel
   scales an iris-shaped golden-angle gather, per-tap LOD footprints keep large radii smooth, and a
   scatter-as-gather acceptance weight plus a separate near-field accumulator keep sharp subjects
   from bleeding into blurred backgrounds.
   Glow-family operations gather from a second chain that stores `blur(bright-pass)` directly: its
   seed pass masks the source by luminance threshold through a per-program uniform and higher mips
   reuse the plain downsample filter, so the fused pass samples the masked pyramid at the same
   radius-to-LOD mapping instead of thresholding an already-diluted blur.
   The parity `effect-shot-manifest` harness exports compiled operations and shared-program hashes
   for every registered effect. The native `effect_shots` example reads the same shared catalog and
   mirrors this path, so offline per-effect PNG renders exercise the same LOD gather the compositor
   uses. The M1 exit shader smoke audits complete effect coverage and all generated PNGs; native
   effect pixel parity remains a separate gate.
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

Background RenderHosts use the same bounded frame pipeline: up to three readbacks overlap ordered
PNG/MP4 writes within a 64 MiB raw lookahead budget, with at most one additional raw frame owned by
the writer. Media preparation is serialized only through exact-frame submission, so asynchronous
image-sequence/SVG generations cannot overtake each other while GPU mapping and encoding proceed
concurrently. Pause retains the
bounded lookahead; cancel and failure drain accepted captures before disposing the renderer.

RenderHosts can opt into `renderFrameInto` with a CPU destination pool sized to the clamped
pipeline depth plus the writer's frame. The pool allocates exact-sized buffers lazily; every
readback still copies all mapped pixels and removes row padding before unmapping. Readback callers
that omit a destination continue to receive a fresh owned buffer. A leased destination remains
exclusive through media retries and all PNG/MP4 output acknowledgements. Cancellation and failure
release the selected frame and drain and release accepted lookahead before renderer disposal.

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

Text uses a retained raster cache keyed by evaluated glyph state: the platform canvas reshapes
glyphs only when the raster signature changes, so expression- and wiggly-driven animation that has
settled reuses the resident texture instead of rerasterizing per frame. The raster canvas uploads
through `queue.copyExternalImageToTexture` into an sRGB texture and is thereafter transformed,
effected, blended, precomposed, and exported by the same GPU path as image layers. Canvas 2D draws the same text model in
compatibility mode. The paragraph box controls wrapping and alignment, while measured glyph ink
(including animator transforms, stroke, and blur) expands the raster and GPU quad without moving the
layer anchor. Text is neither clipped to the box nor horizontally squeezed to fit it. Temporal text
samples share the union of their local ink bounds, with texture density still capped by GPU limits
and the existing temporal memory budgets. Inline editing grows vertically around the same baseline.
A future native shaper/atlas can replace raster-cache creation without changing
the render graph.
Text animation time clamping depends only on animation tracks and source time; cache lookup and
motion-blur planning do not segment the text just to compute an unused character count.

Imported `.cube` resources are parsed through a bounded project boundary, stored in red-fastest
voxel order, packed to `rgba16float`, and cached per effected layer. The fused shader supports both
hardware trilinear sampling and explicit tetrahedral interpolation; layers without a LUT bind a tiny
identity texture so the pipeline layout stays stable.
The shared post-process shader uses one source sample when blur, glow and chromatic aberration are
all zero, skipping the chromatic offset samples and nine-tap blur. A single uniform branch preserves
the original active effect path and keeps the source texture on the GPU.

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

The Electron shell supplies native GPU capacity and free-memory snapshots, matched to the WebGPU
rendering adapter. Preview and isolated export share the automatic/manual policy in
`core/rendering/gpu-memory-policy.ts`, resolved before initial target allocation. Automatic mode
reserves 1 GiB from measured free memory and rounds down to whole GiB, with a small-memory fallback;
manual budgets are capped by detected capacity. Settings can refresh the snapshot explicitly.
On Windows, confirmed UMA adapters include shared system memory in capacity; their free-memory
estimate bounds the shared portion by available system RAM. Discrete GPUs retain dedicated budgets.
Existing per-resource safety limits remain independent; this preference is an allocation-planning
budget rather than a process-wide physical-memory reservation. Platform limitations and fallback
behavior are documented in [Desktop foundations](DESKTOP_FOUNDATIONS.md).

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

Typed editing batches use a disposable Worker and a single candidate project copy with final
whole-document validation. The same worker hosts the scoped `aster` scripting API in QuickJS WASM;
only bounded JSON queries and normalized operations cross the VM boundary. Script execution returns
a job ID, supports progress and hard cancellation, and publishes its candidate only after successful
validation. Workspace byte budgets charge operation payloads and positive document growth separately
from the shared base snapshot. Idle expiry pauses during editing and previews. Request receipts
survive commits in the MCP client session, preventing duplicate mutations after a retried response.
The editor commits the resulting operation list as one history transaction. See the bulk-editing
section of [External Automation](AUTOMATION.md#bulk-editing-and-isolated-scripts) for limits and
receipt lifetimes. No project format or native plugin ABI changes are introduced.

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

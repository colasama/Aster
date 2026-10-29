# Architecture

Production output supports shared, time-independent [anti-aliasing modes](ANTI_ALIASING.md): FXAA at
native resolution and SSAA with larger internal targets. The final GPU pass precedes canonical frame
readback; preferences and queued job snapshots carry the selected mode.

GPU selection defaults to high performance. The persisted high-performance/low-power preference
configures Electron before GPU process startup and WebGPU adapter requests for preview, export,
and memory detection. Changes apply after application restart; platform GPU selection remains
authoritative. See [desktop preferences](DESKTOP_FOUNDATIONS.md).

Aster separates its portable model from platform/UI code. The Rust crates own deterministic domain
logic, project evaluation and rendering; the React/Electron application owns interactive editing and
GPU texture presentation. Electron's sandboxed renderer reaches native capabilities only
through a context-isolated preload API, a main-process command allowlist, and the JSON-lines desktop
bridge. Local media uses a dedicated protocol whose path set is populated only by validated bridge
responses.

Production preview and all queued still, sequence and video exports use Rust project evaluation and
rendering. The production bundle excludes the TS WebGPU renderer and hidden RenderHost; frozen TS
modules are built only into the reference runtime. Canvas 2D remains an interactive compatibility
backend. Missing native export capabilities fail explicitly. The current ownership and delivery
boundaries are summarized in [Production Render Contract](PRODUCTION_RENDER_CONTRACT.md).

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

In the frozen reference runtime, `WebGpuRenderer` coordinates frame evaluation, passes and lifecycle.
Its `RendererResources` owns
allocation, resizing helpers, and disposal of its GPU resources and media/surface caches; scene batch
submission has its own module. Frame buffers remain GPU-resident until an explicit readback.

`aster-renderer` executes validated supplied frame bundles on a headless native wgpu device.
Its supplied-plan capability covers solid/vector draws, image and raster pixels, fixed and backdrop
blends, display conversion and all four AA modes. It consumes shared WGSL and exact supplied geometry, lighting, clear and
post-process buffers; it does not evaluate projects or open media paths. Unsupported operations
return explicit errors before rendering. Supplied layer programs now execute mask groups, channel
mattes, feathering, exposure and inversion through the shared post shader. Fixed composites blend
isolated output once; adjustment passes snapshot the accumulated scene and replace it after processing.
Child-first precomposition surfaces use the shared premultiplied surface shader and the same scene
executor, including nested adjustments, the complete registered effect/style catalog, LUTs and
blur/glow pyramids. Production preview and exports use the native project renderer; frozen TS
execution remains available only in the independent reference runtime.

Surface routing is checked against the graph, geometry mappings and exact resource closure before
GPU execution. Child scene/effect headers retain their own time and composition identity. Cached
HDR/depth allocations are admitted for the complete frame before replacement; exact matches are kept,
unused compatible targets are reassigned, and old incompatible targets retire after GPU completion.
Pixels are rerendered from supplied inputs every frame, so allocation reuse cannot serve stale content.
Image and surface caches share the configured GPU budget with frame, layer and pyramid intermediates.
Blur and bright-pass chains allocate only the mip levels their supplied radii require. Conservative
effect bounds and GPU-resident layer results reduce repeated work while unsupported bounds/history
retain full execution. SSAA effects remain full resolution after reduced-grid parity rejection.

The application host may supply an explicit DXC library through `NativeOptions.dxcompiler`
(`render-plan --dxcompiler` for diagnostics). The renderer has no dependency on a development install
path. Full layer pipelines compile lazily and remain cached on the device; zero-operation display
passes retain their existing specialization. Windows migration verification pins and uses the DXC
library already shipped with the installed Electron runtime; no compiler download is performed.

Linear HDR scene and isolated layer intermediates stay on the GPU. Frame targets are reused by
extent under a configured allocation budget; a returned frame leases its output until released,
preventing reuse while a consumer still owns it. `aster-render-cli render-plan` uses an explicit
diagnostic readback to publish a PNG atomically. Future preview and encoder consumers use the GPU
texture directly. The CLI verifies the exact content-addressed resource closure before execution
and reports adapter identity and input/output hashes for independent pixel verification.

Native still-image draws sample cached `rgba8unorm-srgb` or linear `rgba16float` textures through the shared image shader.
The cache key includes both frame identity and pixel content hash, so an updated pixel generation
cannot reuse stale content. Frame admission checks complete texture demand before mutation; LRU
eviction excludes current-frame inputs and waits for submitted GPU work only under memory pressure.
Scene targets and cached image textures share the configured GPU budget. Unchanged textures are
not uploaded again, and frame plans retain resource keys instead of copying image pixels.
Diagnostic receipts report upload/hit/eviction counts and explicitly identify supplied-pixel
execution as distinct from native file decoding.

Supplied text, SVG and PSD rasters use the same native GPU image cache. Admission accepts captured
byte buffers or typed `RasterPixels` resources, validates the frame binding, extent and format, and
keys allocations by both frame and pixel generation. Repeated static rasters reuse resident textures;
changed pixels replace the old generation within the shared budget. Rasterization still belongs to
the Phase A producer.

Native temporal text passes consume supplied sample identities and exposure weights through shared
WGSL. Retained `rgba16float` accumulation and `rgba8unorm-srgb` output targets stay GPU-resident;
every execution clears previous exposure. Preparation validates sample identity, format, extent
and the complete target/uniform budget before allocating. Partial exposure preserves its transparent
weight instead of renormalizing visible samples. Frame-wide media resolution installs these derived
outputs before root and recursive scene draws. Samples reuse the image cache; captured resolved
pixels are validated but never uploaded. Derived generation keys include the pass and every sample
pixel generation, so nested effect caches invalidate when exposure or samples change. Temporal targets
and aligned uniforms share the frame GPU budget; obsolete targets retire before other caches allocate.
Root beauty motion reconstruction now consumes the same supplied auxiliary geometry, object IDs
and motion vectors, including GPU-derived temporal text. Shared tile-max, neighbor-max and
ID-aware reconstruction passes retain linear HDR targets within the frame budget before display
transform and AA. Switching to an ordinary frame retires motion targets before cache budgets are
reassigned. Root depth output now executes the shared depth shader against primary surface data,
exact front color, transparency-weighted world positions and a second depth-peeled layer. These
targets remain GPU-resident, reuse matching extents and tiers, and retire before other caches can
reuse their budget. Supplied camera geometry also executes the shared shadow depth pass at the
plan's declared map size. Shadow caster geometry and map size participate in post-effect cache keys.
Motion reconstruction feeds depth shading through its retained HDR texture; declared attachment
roles select scene or motion pixels without CPU readback. All three depth tiers and diagnostic
views execute shared shaders over real auxiliary attachments before AA. Integer ID views retain
integer texture bindings. Material HDR lighting and native normal textures use the shared shape variant;
recursive shadows and generators retain separate gates.

`aster-media-native` resolves PNG/JPEG sources from explicit job grants keyed by source hash and
authorization scope. It checks file size, SHA-256 and the imported content identity, then feeds an
immutable snapshot to the existing bounded FFmpeg process through stdin. Encoded dimensions are
checked before codec execution; source/pixel budgets, timeout and cancellation bound the work.
The child receives no source path. Eight-bit associated-alpha rounding preserves the browser import
precision boundary before straight sRGB pixels enter the GPU cache. The CLI accepts original plans
with `--media-authorizations` and `--ffmpeg`. Supplied pixel attachments may accompany native media
only for raster descriptors such as text, SVG and PSD; file-media pixels cannot bypass native decode.
Receipts bind source and decoded hashes, including FNV and SHA-256 imported source identities.

Image-sequence grants additionally bind an exact integer member. The snapshot must match both the
grant SHA-256 and the member file identity carried by the plan. Source-wide still grants cannot open
sequence members; no filename or time-based inference occurs. Original sequence plans can execute
in a retained-device batch, with content-addressed GPU images reused across holds and reverse seeks.

Native SDR BT.709 H.264 video uses the same source authorization boundary and a private seekable
snapshot. FFprobe supplies presentation timestamps; exact rational interval selection and matching
requested/uploaded frame identities precede FFmpeg decode by presentation-order index. Centered
chroma reconstruction through 4:4:4 preserves the browser upload contract. Receipts retain source
color metadata and identify the CPU decode/upload path. Untagged limited-range SD H.264 4:2:0
(at most 1024 by 576) additionally follows the measured Chromium SMPTE 170M interpretation:
clip decoded RGB before converting primaries with the legacy sRGB transfer, retaining ten-bit
precision through the intermediate YUV bridge. Raw probe tags distinguish missing metadata from
unsupported explicit tags; untagged HD and explicit unsupported color spaces remain rejected.
Batch jobs retain immutable grants and a
bounded LRU of verified decoded frames, keyed by full frame content identity. Pixel-byte and entry
budgets independently bound retention; cancellation is checked even for a cache hit. GPU image
reuse remains independent of the CPU decode cache. Decoded frames retain an immutable in-process
resource proof, so cache hits and temporary registry installation share the same pixel allocation
and computed content hash. The proof cannot be deserialized or mutated. Every installation still
checks registry budgets, dependencies and pins; external resource messages always authenticate
their bytes. Native files and supplied raster generations
share the same root and recursive scene resource closure, including temporal text samples and
derived outputs. Streaming codec state and production routing remain separate capability work.

Authorized EXR snapshots use the existing Rust `exr` library with bounded metadata and single-layer
float RGB(A) admission. The frame descriptor declares `rgba16float`; half-float byte budgets flow
through registry admission, texture upload and cache eviction. EXR associated linear RGB is converted
to straight linear samples for the shared image shader, preserving HDR and negative finite values.
Unsupported color primaries, deep/multipart files, incompatible display windows and non-finite or
half-float-overflowing samples reject explicitly. Reads observe cancellation and timeout; decode
remains sequential to bound working memory. Browser raster payloads retain their eight-bit format.

The migration's `aster-render-ir` crate owns typed frame-plan transport and its generated schema.
TS DataView and Rust owned-buffer codecs share a canonical FPLN container with aligned binary blobs
and separate content-addressed resource operations. Canonical JSON sorts the serializer-owned
object tree, including nested objects under insertion-order dependency features, and writes it once;
resource hashes and FPLN metadata retain the same lexical ordering, escaping and numeric bytes.
The initial contract carries an explicit
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
after readiness and resolves the supplied plan before encoding. TS/Rust FPLN preserves them exactly.
Native authorized still, sequence and video resolution now feeds captured-frame execution together
with supplied raster generations; application routing remains gated until native export and preview
integration.

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
Native consumers use `aster-text` for bounded file discovery and a separately owned face catalog.
The catalog parses OpenType, TrueType and collections with `read-fonts`; it authenticates complete
font hashes and collection indices, admits collections atomically, and bounds font bytes, faces,
family names and variation axes. ICU default case folding matches localized family aliases without
Unicode normalization. Ordered family selection ranks physical width, style and weight and retains
explicit weight/width variation coordinates. Selection alone does not establish glyph coverage,
shaping support or pixel parity. Project font sets validate the existing 32-face/8 MiB source
schema and atomically replace their catalog, preserving authored family aliases and CSS weight
descriptors ahead of matching platform families. Their content-derived revision includes ordered
font bytes, identities, aliases and weight descriptors; in-flight users retain immutable byte handles.
WOFF1 decoding bounds reconstructed bytes before allocation, validates offsets, padding, zlib
completion and checksums, and rebuilds the SFNT header. WOFF2 remains an opaque retained-provider
request whose bytes still require that provider's validation; embedded collection selection also
has an explicit retained-provider reason. Neither silently substitutes a platform font.
This native foundation does not change the active Chromium text raster path or editor font inventory;
production routing and layout/pixel acceptance are separate integration requirements.

The diagnostic text-layout capture observes production Canvas measurements and draw calls, including
wrapped lines, baseline anchors, transforms and temporal samples. It covers declared and deterministic
random corpus times plus authored text intervals in every composition. Ordinary and extended-metrics
browser runs must agree exactly on common layout fields and raster pixels; instrumentation is also
checked against an untouched raster in each run. Source, project, embedded-font, system-font inventory,
browser and locale identities bind the observations. Chromium's diagnostic cluster API adds UTF-16
spans and selection geometry, not raw glyph identities. These observations support subsequent native
layout comparisons but cannot by themselves establish per-glyph or native text pixel acceptance.
Original reference rasters remain unchanged.

Native text layout uses HarfRust behind `aster-text`, with authenticated physical faces and complete
variation locations. Shaping returns UTF-16 cluster spans, glyph IDs, advances and offsets; ordered
fallback faces are selected at grapheme boundaries. ICU4X supplies word and grapheme segmentation.
Line layout preserves the existing first-token overflow, whitespace trimming, tracking, alignment,
leading and per-grapheme draw rules. Typographic line metrics determine the normalized Canvas middle
baseline. Codepoint, glyph-expansion, font-chain, measurement-work and output limits reject incomplete
results before publication. Homogeneous RTL runs are supported; mixed bidi and unverified implicit
platform fallback have explicit retained-renderer reasons.
The `text-layout` diagnostic compares this component against actual Canvas observations, including
wrapped lines and observed natural line anchors before animator compensation, including empty lines.
Its system-font inventory keeps only requested families resident.
Embedded font sets can supply the same immutable native face interface; the diagnostic currently
rejects embedded-project comparisons instead of substituting system fonts. Component metric success
does not establish raw browser glyph identity, native raster pixels or production text routing.

Glyph rasterization uses Skrifa's shared Fontations parser and Zeno coverage rasterization behind
`aster-text`. Scalable outlines support fractional baseline phase, fill, round-joined stroke and
optional vertical embedded hinting with linear advances preserved. The Windows platform adapter uses
DirectWrite against authenticated in-memory font bytes, explicit face indices and variation axes;
it never performs independent font substitution. Font copies have an explicit 32 MiB budget (configurable up to 64 MiB), alpha textures retain the raster
allocation limits, and loader registrations are released on success and failure. Platform strokes
use bounded horizontally oversampled coverage filtering. Windows Canvas coverage uses an explicit
sRGB gamma/contrast transfer; its policy and foreground color are part of the glyph cache key.
Unsupported platform adapters produce a retained-capability result. Embedded mask, BGRA and PNG
strikes decode under dimension and memory limits; color resampling uses premultiplied sRGB bytes.
Whitespace retains its advance without an image or upload. Layered color paint graphs and bitmap
strokes return explicit unsupported reasons until verified implementations are available.

Raster identities include complete face hashes and indices, variation coordinates, glyph IDs,
sizes, both fractional coordinates, paint, foreground color, bitmap policy and hinting mode.
Glyph caches account for externally leased images. Immutable atlas generations pack coverage and
color into separate padded pages; a held generation cannot be evicted or have its coordinates
reused. Consumers must retain its lease until all corresponding GPU work retires. The diagnostic
publishes authenticated glyph and atlas images and independently reconstructs every atlas cell,
including empty padding, without claiming production text pixel acceptance.

`GlyphTextPipeline` composites the immutable atlas on the GPU using ordered fill/stroke draws,
evaluated affine transforms, color/opacity and output-space clips. Coverage pages use R8 unorm;
color pages retain premultiplied encoded sRGB. Source-over blending matches the default Canvas2D
encoded-sRGB convention. A GPU resolve produces straight encoded bytes through an unorm view of an
sRGB output texture, so downstream effects and temporal accumulation decode exactly once.
Atlas uploads validate complete page bytes and placements before allocation. Output preparation
bounds draw counts, dimensions, uniforms and both targets before allocating; prepared passes retain
the atlas generation and clear targets on every recording. No normal-path CPU readback is needed.
The image cache retains derived textures as well as bindings, installs glyph and temporal generations
without replacing each other, and clears them once at frame admission. Frozen independent Canvas
component captures cover overlap, stroke, transforms, clipping, color and fractional sampling;
production project routing and full text raster acceptance remain separate integration requirements.

Native frame admission accepts an explicit `NativeGlyphInput` alongside the existing validated
resource bundle. Its private recipe binds atlas bytes, coordinates, ordered styles and output extent;
the media descriptor must identify a text raster with matching dimensions and format. External
bundles still require pixel payloads. Missing, duplicate, unused or overlapping native inputs fail
the same complete frame closure checks, including nested scenes and temporal samples.
The renderer reserves atlas pages, composition targets and draw uniforms within the frame budget,
retires obsolete generations before allocation, and retains unchanged GPU outputs across frames.
Glyph composition precedes temporal accumulation and scene draws in one command submission. Native
text outputs bypass full-frame CPU pixel upload.

`NativeProjectText` binds embedded font inventory and authored text to the same compiled project
revision. Its job-local platform catalog and bounded face-chain cache feed native line layout,
UTF-16 selector domains, time-addressable text animation, ink measurement and immutable atlas recipes.
Paint runs preserve replacement-character advances, tracking compensation, line spacing, projected
transforms, CSS color quantization and stroke-before-fill order. Raster density is recomputed from
the measured bounds, including the independent ceiling of each output dimension; temporal callers
may supply a containing union without changing each sample's evaluation time. Translated glyphs
use Canvas quarter-pixel horizontal and integer vertical cache phases. Quoted family names preserve
literal identity separately from CSS generic names, with ECMAScript whitespace normalization.
Unsupported font containers, missing glyphs, synthetic styles and unavailable raster features
produce request-scoped capability evidence; malformed inputs and resource exhaustion remain errors.
Preparation emits no full-layer CPU image. Production sessions partition ordered raster requests:
qualified Windows outline fills use native atlas recipes, while request-scoped capability reasons
retain unqualified strokes, animated/temporal text, scripts, densities and font selection paths.
Initial coverage admits ordinary ASCII Arial/Segoe UI fills at unit raster density with translated
glyphs; quoted/escaped CSS family syntax and color glyphs remain retained. The retained response
must authenticate the exact remaining request digest before native descriptors and bounds merge;
no synthetic CPU raster or substituted response digest grants native admission. Cloner instances
preserve last-write ownership, and a retained occurrence retains that instance's complete sequence.
Actual Canvas observations validate authored preparation geometry independently of atlas tests.
Production tests prove retained text request omission, stale-frame rejection and actual GPU glyph
layer pixels. Explicit diagnostic readback resolves a resident immutable generation; normal preview
and export remain GPU-resident. This limited capability does not complete the text milestone.
The same acquisition boundary audits native request partitioning and authenticated retained-provider
replies across corpus, owner and nested text samples. Unavailable font chains retain their concrete
reason before broader raster qualification decisions. Independent Canvas observations also capture
the actual RGBA8 GPU upload boundary: Canvas readback and uploaded texture bytes can differ in
rounding, so exact retained-pixel checks compare the same representation. Fresh retained references
also use production frame-rate sampling independently of exact-time layout observations. Font
discovery reads family names without requiring native paint support; extended-range colors retain
the M5 path with a specific capability reason. Temporal audits preserve
sample order, weights and resource closure; they do not substitute for shared-union pixel acceptance.
Embedded-container qualification uses locally wrapped WOFF2 and single-face collections of the
same installed outline font, with a different installed family as the project alias. Independent
TTF controls require identical pixels and bounds; an unembedded alias control must differ, making
silent platform substitution observable. Live retained routing binds font bytes, project revision
and the exact container capability reason. Malformed font data and stale project digests must fail
provider admission before any frame receipt. Font bytes remain local verification artifacts.
Production text routes record the resolved physical face digests, collection indices and variation
coordinates. A bounded job-local coverage cache probes declared paragraphs before broad raster
qualification, preserving missing-glyph UTF-16 intervals and explicit bidi limitations. Cache keys
bind text, locale and the resolved font chain; line separators advance the authored UTF-16 offset.
These probes allocate no glyph atlas and do not expand native raster admission. Retained-provider
checks cover missing families, same-font valid/missing glyph controls, explicit fallback chains and
system/embedded mixed-bidi text with exact independent pixel comparisons.
Static authored glyph-paint probes share the rasterizer's bitmap-versus-color selection rules.
They identify the physical face, glyph and authored font size for layered-color or bitmap-stroke
limitations without allocating pixels or atlas leases. Their bounded cache also binds font size,
stroke width and animation state. Real rasterizer controls distinguish ordinary outlines in a
color font and supported bitmap fills from the unsupported paints; independent M5 pixel comparisons
authenticate the resulting retained production routes. Animated paints remain separately qualified.
Animated capability probes share layout, ink bounds and final raster density with native text
preparation before any atlas allocation. They evaluate the selected character paints at the requested
time, including individual exposure samples, and retain nonzero blur with the affected paint index
and scaled radius. A bounded cache binds the immutable project layer, style, physical fonts, locale,
density and canonical animation time. Independent Canvas draw filters and exact retained pixels
distinguish active blur from zero, disabled, unselected and time-varying controls; native preparation
must independently reject the same unsupported filter. These probes do not grant native admission.
Ordinary embedded outlines are qualified through the production project shaper and GPU session.
An installed face is embedded under a different installed family alias; independent TS observations
must match the original physical face exactly, while the unembedded alias must differ. The project
diff is restricted to font delivery and family selection. Native per-glyph advances, baselines and
line breaks are checked against embedded-font Canvas observations, and selected physical face digests
must match the embedded bytes. Full frames remain bound to the equivalent frozen scene; isolated
GPU pixels, stale-frame rejection and independent capture/replay remain required.
An embedded alias alone cannot confer native raster qualification: its physical face must match
an installed face from the qualified outline families. Other embedded faces retain their exact
font identity and an explicit qualification reason. An unrelated physical font embedded under the
same alias is checked through real retained routing and exact independent pixels.
The text milestone exit audit binds the current full static and GPU reports to authored corpus
coverage, including owner compositions and nested text layers. Every admitted production sample
must have an observed glyph position, advance and baseline within 0.5 px, identical line breaks,
matching physical fonts and a reviewed perceptual GPU comparison. Retained cases keep exact M5
pixels and explicit capability tasks in the migration ledger. Diagnostic shaping or atlas success
alone cannot confer text acceptance; native preview acceptance remains separate.

Final production pixel verification combines two independently complete paths: the current native
authored-project corpus and desktop native preview. Both must pass their existing pixel and
self-review rules. The aggregate pins the project-corpus report and each child report, checks source
identity and rejects partial coverage or reports changed during execution. M12 uses native project/IR,
corpus and project-export gates; this pixel aggregate alone does not establish performance,
application delivery or final migration acceptance.

Final application verification runs packaged foreground and background preview without native enable
flags, then binds editor interaction/plugin/recovery evidence to the same renderer. It reads the
actual packaged archive's production renderer boundary and rejects retained TS renderer modules.
The live application queue must publish still PNG, PNG sequence and H.264/AAC outputs through native
workers, with persisted completion, released temporary jobs and no retired render-host or browser
MP4 IPC. Reports, output hashes, packaged binaries and source identities remain bound through the
aggregate; missing current preview latency evidence leaves this gate incomplete.

Final migration acceptance binds all seven full gates and their child reports to one current
invocation. It reconstructs complete project/sample/export coverage, authenticates admitted pixel
reviews, recomputes paired export and preview performance, and checks independent input latency.
Image decoding and numerical pixel checks already completed by those gates are not repeated.
The packaged renderer must match the measured export renderer; completed delivery review pins the
affected documents so later edits invalidate that review. Partial checks and unfinished delivery
tasks cannot establish final acceptance.

Native preview transport reserves one to three lossless BGRA sharing surfaces before rendering.
Each surface remains immutable while a consumer owns its lease. DX12 completion precedes publication,
and an owned duplicate NT handle is bound to the importing process identity. An independent bounded
handle guard owns the consumer duplicates before acknowledging publication. It monitors producer
exit and control EOF, reclaiming original handles even after abrupt producer termination; Chromium
retains its own imported resource references until GPU use finishes. The experimental
`preview-plan` sidecar accepts bounded controls for supplied-frame presentation and release.
`preview-project` evaluates explicit times against immutable native project snapshots. Its media
admission follows the visible composition graph, so later seeks can acquire sources that were absent
at the initial time. Snapshot replacement requires drained consumer leases and a strictly increasing
generation; same-size replacements retain the GPU device and caches, while resize retires the old
allocation generation first. Readiness binds the authored/runtime hashes, scope, revision, composition
and target; frame replies carry the exact requested time and generation. `NativePreviewClient`
serializes these controls and bounds queued work.
`NativePreviewBroker` imports only in Electron's main process and releases the native lease only
after Electron reports that every process and GPU reference has finished. Renderer IPC receives
the shared texture and frame identity, never the raw NT handle. GPU copies and explicit readbacks
preserve associated RGB and alpha. The editor swapchain and comparison snapshots are opaque,
displaying associated RGB over black to match the retained TS viewport. Native preview is enabled by
default and connects the editor to application-owned private project snapshots; IPC clients cannot select executables or
filesystem destinations. The sandboxed preload transfers owned VideoFrames to the GPU canvas, which
checks snapshot identity and validation before closing them. Electron retains their underlying
resources until GPU use finishes. The broker acknowledges presentation only after
`allReferencesReleased` and the native lease-release reply; bounded drain failures terminate the
producer. This provides the GPU completion boundary without another renderer-process queue wait.
`ASTER_NATIVE_PREVIEW=0` selects the unchanged Canvas 2D compatibility path, without an implicit TS
GPU fallback. TS viewport creation requires a separate `vite build --mode reference` bundle in
`dist-reference` and the development-only `ASTER_REFERENCE_RENDERER=1` application route. Packaged
applications ignore that reference route. Queue exports use native project workers by default.
Production presentation has an independent beauty contract and Canvas adapter; the original TS
beauty implementation remains immutable for reference capture. The build rejects production chunks
containing the TS renderer, its original beauty adapter or the legacy RenderHost. Reference builds
retain those modules explicitly and emit their separate renderer-boundary report.
Explicit pixel captures also wait for their mapped readback buffer. A replaceable foreground queue rejects
stale edits while idle pre-rendering fills the bounded RAM cache without changing the displayed frame.
The native idle scheduler iterates only its budgeted frame window, without allocating a list for the
entire work area. Editing, quality changes and playback invalidate in-flight idle completions before
they can enter the cache or update the displayed frame.
Presentation-device loss is persistent. The view can retire its old session and recreate the device,
or reopen a crashed native producer, once per request. Invalid input and mismatched frame identities
remain errors. Host disposal waits for retirements already triggered by renderer loss or navigation.
Packaged raster workers use the application bootstrap and an external HTML resource directory so
native path validation never depends on Electron's virtual ASAR filesystem.
Explicit beauty captures reuse native evaluation and offscreen readback at exact requested times.
Editor comparison snapshots serialize with foreground work, cancel idle rendering, and preserve the
requested time, diagnostic mode and selected layer. The receiver copies the authenticated live
VideoFrame into a separate canvas capped at 2048 pixels per side; it never reads a previous swapchain
frame or changes the displayed viewport. Context changes and teardown discard pending comparison
results, and temporary canvas pixels are released after publication.
Native editor qualification drives the diagnostic selector, snapshot button, keyboard movement and
pointer-drag preview/commit/undo in both rendering engines, binding every native snapshot to its
actual IPC call and exact playhead time. Diagnostic depth views use primary auxiliary surfaces,
matching the TS editor; camera beauty depth of field retains its budgeted layered attachments.
Installed-plugin qualification uses the real plugin manager in isolated application profiles. Paired
root and nested compositions cover installation, successful and rejected hot reload, disable/enable,
safe-mode recovery and missing packages, including live registry invalidation without reopening the
active project. Pixel checks require visible reload changes and retention of the last valid shader.
The editor benchmark uses uncached native evaluation and waits for GPU presentation; its synthetic
compositions are materialized into authored snapshots. Exclusive benchmark ownership drains foreground
work and suspends idle pre-rendering. Preview snapshots include the reachable composition graph,
including future and hidden dependencies. Authorized legacy assets are copied into the private store;
immutable media identities allow geometry-only revisions to reuse those admitted copies.
Installed scene generators enter preview through a main-process-only bridge command. It freezes
the plugin manager's admitted manifest and shader sources, including its last valid version after a
rejected hot reload. The renderer supplies project references, never plugin paths or executable
content. Main persists bounded immutable packages in the private session, binds their content digest
and explicit unavailable identities into the snapshot scope, and Rust validates the packages again.
Activated registry changes replace the native snapshot and invalidate frame-cache scope. Disabled,
safe-mode and missing generators are explicitly classified and logged; only those identities may be
omitted from root and nested scene commands while preserving surrounding content. Other missing or
invalid contracts remain errors, and built-in generators cannot receive unavailable grants.
The preview raster transport retains at most 64 MiB of verified immutable pixel resources from its
preceding frame. Rust advertises only resident identities, and Electron intersects them with its
previous metadata before the renderer may omit bytes. Cache hits retain exact descriptor, raw digest,
frame-request and aggregate-budget checks. Misses undergo full content verification; eviction requires
retransmission. The ordinary capture interface still returns owned bytes.
Full corpus parity, paired performance,
packaged startup and crash recovery remain required before enabling the production default.
Explicit project captures and selected export witnesses materialize resident native text outputs
as bounded, content-addressed raster resources for external replay. They preserve `submitted.fpln`
and its digest separately from the replay envelope, and record exact text capability decisions and
frame-to-pixel links. Only root-envelope pixel dependencies and their count change; authored scene
resources remain unchanged. Independent supplied-frame replay requires real pixel payloads and
cannot acquire native recipe authority from an external plan. Production-session tests require
byte-identical replay and verify that the original pixel-free bundle is rejected by external admission.
The authored-pixel diagnostic removes the supplied CPU text raster and renders the native recipe
against authenticated frozen plans. It compares both the complete frame and an isolated text crop,
checking that the latter retains the original raster alpha and only GPU premultiplication rounding.
Failed isolated coverage remains an explicit retained requirement even when a padded frame passes;
diagnostic completion does not grant native production admission or complete the text milestone.

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
| `aster-render-cli` | Headless authored-project evaluation, rendering and export; supplied-plan diagnostics and image comparison |
| `aster-profiler` | RAII CPU timing and rolling metrics |
| `aster-project` | Versioned bundle validation, lossless authored documents, bounded runtime upgrades and atomic persistence |
| `aster-eval` | Native time-addressable project evaluation and frame-plan assembly, including bounded expressions, animation, scene geometry, effects, audio analysis and text animators |
| `aster-render-project` | Job-owned project sessions, authenticated media and raster acquisition, native GPU frame preparation and submission |
| `aster-plugin` | Manifest, parameter, permission, and capability validation |
| `aster-desktop-bridge` | Electron sidecar protocol, native project I/O, and plugin runtime |

Native effect kernels emit the existing 16-float operation ABI in composition render order.
The development-time translator emits ordinary Rust and pins its TS sources for parity checks;
the native runtime does not invoke JavaScript. Bokeh choice tables and stable-sorted gradient
stops use explicit Rust kernels. Native text animation consumes supplied layout units until native
shaping and rasterization replace that boundary.

Native cloners cache static distributions and preserve instance identities while sharing source
resources across nested clones. Audio analysis uses bounded radix-2 FFTs and explicit absolute
sample reads, producing the existing 9,280-byte generator audio ABI independently of seek order.
Generator input evaluation reuses the native plugin graph validator, retains authoring parameters
at double precision, and packs the shared context, parameter, indirect and dispatch records under
device budgets. Native project sessions enforce shader admission and resource assembly as separate
boundaries. Whole-project plan and pixel gates exercise the integrated path in addition to component checks.

Native frame producers own validated scene, lighting and post-process buffers, exact binary frame
times and frame rates, effect routing/fusion records, LUT texture resources, and root draw commands.
The root command producer preserves bottom-to-top ordering, 3D-to-2D depth boundaries, isolated
layers, adjustments and generator availability. Effect programs borrow compiled tracks rather than
copying them per frame; LUT packing preserves the established half-float rounding and resource hash.
Component oracles compare metadata and packed bytes against TS. Complete authenticated media
assembly remains required before native project rendering can pass the whole-frame gates.

Native motion planning evaluates shutter endpoints directly, matches full selection/instance/resource
identities and vertex counts, and emits zero velocity for missing or changed topology. The same
bounded shutter interval drives reconstruction uniforms and optional scene-vector payloads. Final
output routing preserves the existing availability rules for beauty, depth and auxiliary displays;
temporal text exposure uses the same shutter interval with native source-time evaluation.

Native recursive surface planning shares targets by revision, composition and source time, applies
the existing depth, texture, dimension and memory budgets, and emits child-first scene/root plans
with explicit graph routes and alias ordering. Geometry consumes the already evaluated, namespaced
child layers. Component oracles verify the graph and command bytes against TS, including deliberate
budget, alias, ordering, route and draw-index corruption. Temporal text planning merges shutter
samples into microsecond cache buckets, retains transparent exposure weights, and inserts
representative exposure-only scenes in render order. Supplied text layout units keep the existing
raster boundary explicit; child surfaces preserve namespaced resource identities across samples.
Locale-sensitive ordering uses pure-Rust ICU4X behind the native text interface with the host's
resolved Intl locale. The pinned Unicode-3.0 dependencies replace a language-specific collation
implementation that would be impractical to maintain locally; they add no native C/C++ runtime.
Native project sessions connect authenticated bundle assembly to project-driven orchestration and
headless resource resolution. Whole-frame gates compare the resulting authored-project captures.

Native auxiliary plans retain geometry draw order, UTF-16 object IDs, surface-before-media bindings,
generator order and packed motion data. File-backed compilation preserves ECMAScript material JSON
property order and number formatting before hashing material IDs. JSON parsing enables exact float
round trips; the shared scalar formatter uses pure-Rust Ryū-js for ECMAScript shortest-decimal
rounding, including halfway values. Allocation state is an explicit
input; unavailable, cleared and drawn outcomes retain the existing texture and attribute budgets.
Component checks compare retained TS plans with mocked allocation handles, including material
ordering and budget boundaries; complete project resource assembly remains separate.

Native depth and surface post producers preserve the existing camera-optics scaling, bounded uniform
packing, attachment fallback roles and ready/skipped outcomes. Their component oracle invokes the
retained TS post-effect classes with allocation handles supplied by the harness, so Rust output
is checked against the existing input-selection logic without running a second GPU pipeline.

Native bundle assembly admits immutable content proofs under the existing 65,536-resource and
64 MiB bounds, resolves media-frame source dependencies, and publishes only the used resource set.
Prepared effect records retain direct/skipped/failed/ready outcomes, encoded programs and LUTs.
Frame and recursive surface bundles preserve UTF-16 identities and diagnostics, generator order,
temporal plans, draw mappings and authenticated media-pixel links. Output-stage consistency is
validated before publication. Component oracles establish exact packing and dependency hashes
from supplied component inputs; they do not establish project-driven native plan or pixel parity.

Project effect preparation resolves compiled source-layer tracks at each flattened instance's local
time, preserves map insertion order, and uses the enclosing render target's pixel scale. Native
generator plans snapshot admitted shader sources into bounded content resources, translate the
validated plugin graph, and pack context, parameters, indirect commands and optional root-time audio.
Temporal raster passes preserve binary64 exposure weights and bind distinct supplied sample/output
identities. These producers are compared with retained TS. Native project sessions coordinate frame
assembly and authorize headless resources; the bounded retained raster provider supplies text/SVG/PSD pixels.

Material planning evaluates normal strength, environment intensity and wrapped rotation before
packing binary64 binding slices. The project producer shares normal maps by resource instance and
binds them to each draw instance; normal/environment bytes remain supplied, authenticated resources.
Scene media binding records exact or pending references alongside geometry, rejects repeated binding,
and retains sorted resource identities without copying geometry payloads.

An immutable native generator catalog admits definitions and deduplicates shader storage under the
bundle resource budget. Project invocation reads compiled source clocks, flattened transforms and
the enclosing camera, while all recursive generators reuse the root-time audio record. Recursive
surface preparation binds media, uses distinct scene/effect/generator snapshot scopes, derives effect
mip counts from each target, and preserves child-first order and diagnostic origins. Generator
records remain planned until execution admission establishes their available capacity.

Native frame preparation shares current geometry between scene packing and stable-identity shutter
matching. Beauty frames evaluate temporal text unions before geometry; diagnostic views retain the
current scene. Camera optics, layer motion eligibility and visualization determine which endpoint
samples and output stages are needed. Raster bounds and text layouts remain explicit supplied inputs.
The output coordinator derives shutter timing from the project, observes auxiliary allocation and
motion readiness, and preserves depth-source fallback, generator exclusion during beauty motion,
selection IDs and final route consistency. Retained TS coordinator comparisons cover all output
modes and unavailable/cleared/drawn resources; complete frame/resource admission remains separate.

The project-frame coordinator now joins scene evaluation, recursive surfaces, effect and material
programs, media bindings, output selection and bounded resource-bundle assembly. Generator realization
observes each exact invocation and must return matching capacity/count or an unavailable outcome;
planned outcomes cannot be published as execution evidence. Root generators are realized before
recursive generators; unavailable root generators are omitted, while recursive records preserve the
observed outcome. Shadow eligibility comes from the evaluated primary light and allocated shadow-map
size. Surface scale must match frame anti-aliasing. Resource acquisition remains an explicit boundary.
TS comparisons cover primitive, moving, effected and isolated child scenes across output modes;
generator, lighting and root/recursive media integration checks extend this coverage. Media tests
distinguish pending frames, authenticated source/frame descriptors and supplied pixel payloads.
Corpus-wide native plan/pixel
acceptance and headless acquisition remain required.

The diagnostic `aster-render-cli plan-project` command upgrades persisted project JSON in memory
through the current TS schema transformations before native evaluation. The runtime loader preserves
authored material property order and unknown fields, bounds input/output bytes and collection sizes,
and never writes the authored document. Lossless bundle persistence remains a separate API. Its G1
oracle covers every corpus project, historical schema transitions and rejection controls; external
owner documents are referenced by path and digest only. The command accepts a typed
frame/resource-observation request and reports both authored and runtime document hashes. Input payloads
are content authenticated under aggregate bounds. Generator observations are keyed by the complete
invocation binary digest, so stale or mismatched allocations cannot authorize a different invocation.
The command atomically publishes a new directory containing `plan.fpln`, `resources.json`, hash-named
payloads and an input/output digest report. It does not acquire media or claim GPU execution; the
headless resource adapter supplies those observations separately.

`aster-project::MediaSourceReader` admits portable payloads and bundle-relative media without
materializing files or trusting stored resolved-path hints. It authenticates byte and content
identities under per-source, inline, aggregate and file-count budgets. External unsaved payloads are
rejected. `aster-media-native` also accepts immutable broker-provided snapshots under separate
resident-byte and entry limits; filesystem and snapshot grants share scope, sequence-member and
descriptor-identity checks. `ProjectMediaCatalog` binds source and payload identities, validates
sequence members and resolves missing-frame policies. `NativeProjectMediaSession` builds media
descriptors from these bindings and native layer source times, using authenticated video metadata
and the retained seek tolerance and microsecond upload clock. Planning can omit pixel decoding;
execution uses the same descriptors through the bounded native media session. G1 checks corpus bytes
against TS identities and file-media descriptors against authenticated TS plan references. Complete
recursive scene assembly and retained raster acquisition remain separate integration requirements.

`aster-render-cli prepare-rasters` resolves retained-raster requests from the native scene, source
clock, transform and text-exposure evaluators. Its bounded JSON input contains a frame address,
font-provider layout units and device limits, without supplied scene or effect plans. Text density
includes composed transforms; SVG density follows the authored local transform. The retained raster
provider consumes these requests through the existing text, SVG and PSD raster implementations,
returns authenticated pixel resources and text bounds, and preserves temporal sample resources until
capture completes. The isolated resource harness checks fresh acquisition against frozen reference
bindings, pixel bytes, font identity and adapter identity. This component boundary does not establish
recursive frame assembly or whole-project native export acceptance.

`prepare-resources` extends native acquisition planning to the complete ordered frame: root text,
recursive surface targets and child media, then root images and video. Frame size and AA determine
root raster density; child text uses its source composition's frame rate and surface resolution,
while child SVG retains the existing default image density. Shared surface sources are acquired once.
File-media requests retain native layer addresses and local times so the admitted media session can
apply source-duration-aware clocks. Target requests describe required allocations and never claim
GPU availability. G1 compares these operations, surface bindings and diagnostics against TS over the
corpus, with additional nested text/SVG cases and explicit corruption controls. Actual allocations,
complete resource acquisition and final frame assembly remain separate steps.

`aster-render-project` owns bounded native project loading and input acquisition for a job.
The CLI's `normalize-project` command exposes the existing Rust runtime schema upgrades to the
main-process queue preparer, publishing a new file atomically with authenticated input/output
receipts. Queue-only legacy footage recipes preserve locator-based source identities while native
media acquisition verifies frozen storage bytes separately; they do not authorize external files.
File media is admitted from the native ordered requests, decoded through authenticated source
snapshots, and bound to native instance identities and source clocks. Descriptor/plan resources
and decoded frame pixels have separate byte budgets: the plan budget does not represent decoded
texture residency. Interrupted file sessions cannot resume partially advanced clocks. Material
acquisition resolves active native mesh bindings, decodes normal maps through the existing native
texture boundary, and converts Radiance environments to the retained RGBA16-float representation.
Content hashes and per-frame budgets remain authoritative before GPU upload.
Serialized plans retain media frame identities; native file-decoder pixels are attached separately
at the existing execution boundary, while retained raster derivations remain in the plan bundle.
In-process native producers retain the encoder's validated metadata and blob ranges when executing
their own root and generator plans. This avoids an immediate JSON decode and canonical re-encode;
the same encoder still checks all caller limits and typed blob invariants and produces identical
FPLN bytes. External containers and byte resources without native proofs continue through the strict
decoder; immutable native nested-plan proofs retain their validated metadata with caller limits.

Native audio acquisition selects audible root-composition sources independently of visual
visibility, authenticates source bytes, and decodes bounded PCM into a job-owned cache. The mixer
preserves separate audio/video solo groups, source time remapping, reversal, channel levels, pan,
Float32 accumulation, and export clipping. Its 48 kHz mono windows feed the native audio-analysis
ABI. A native session skips analysis when its immutable project snapshot contains no generator
layers. Any generator, including hidden, nested, inactive or unavailable instances, conservatively
retains the existing analysis path. Audio mixing and output-track selection remain independent.
Input component gates compare material bytes, ordered media bindings, PCM mixes and analysis
windows with independent retained TS results. These gates do not establish final pixel parity or
complete project export, and production rendering remains capability-gated until those gates pass.

Audio is decoded at the source rate before the native compatibility resampler produces the 48 kHz
analysis input. Integer normalization preserves Chromium's positive/negative full-scale distinction;
the windowed-sinc kernel, block phase progression and Float32 reduction order preserve the retained
decoder's results. Source sample format is obtained from the same bounded probe as stream metadata.
Resampling validates the output byte budget before allocation and checks cancellation by block.

Native project preparation allocates root and precomposition targets on the same renderer device
that executes the frame. Generator readiness follows shader validation, pipeline creation and real
context, parameter, indirect, storage and audio buffer allocation. The execution path reuses these
handles by an identity containing the evaluated invocation and its owned audio bytes, and rejects a final
generator or target closure that differs from its preparation. Admission accounts for retained
cache residency and invalidates preparation on GPU allocation failure. Growing targets retire
least-recent image generations before reserving space; final frame admission re-uploads any needed
generation. Mandatory attachments still fail when they exceed the configured budget. Auxiliary attribute targets
also support bounded retained buffers; their uploads are ordered before the corresponding GPU draws.
The supplied-plan path retains its existing transient attribute behavior.

Output preparation shares the retained primary attachments across depth, motion and diagnostic
passes. It admits transparency tiers and attribute capacity against the configured budgets before
publishing final output plans. Motion readiness includes a real post-process binding that is reused
with ordered uniform uploads. Root-time audio remains shared across root and child generators;
unrelated analysis does not change the identity of a generator that does not consume audio.

The job-local `NativeProjectSession` assembles these inputs, evaluates complete native plans and
publishes a prepared frame only after resource and execution validation. Prepared frames carry a
session identity and generation; stale or repeated submission is rejected, and acquisition or GPU
failure poisons the session. Retained text, SVG and PSD raster responses bind to a digest of the
native ordered requests. Their bounded payload files, resource descriptors and pixel hashes are
verified before admission. Bundled particle metadata is generated at build time and checked against
shared WGSL identities, so native frame evaluation does not require a TypeScript runtime.
Explicitly selected installed generators pass the existing native manifest and shader validator.
Their program identities preserve the bridge's Float32-to-JSON promotion and locale-sorted text
fingerprint, while shader bytes and aggregate admission budgets remain independently validated.

The diagnostic `aster-render-cli render-project` command accepts bounded project jobs containing
frame addresses, raster-provider settings and optional authenticated raster responses. It acquires
file media, audio and materials itself, evaluates native plans and executes them on a retained GPU.
It accepts no supplied scene plans or allocation observations. A complete job publishes its plans,
content-addressed resource closure, PNG frames and hashed receipts together in a new directory;
failed jobs remove unpublished staging and never replace existing output. Explicit capture byte
budgets bound disk output independently of frame resource budgets. PNG readback is diagnostic and
does not define the production preview or encoding path.

Beauty video exports retain at most one next-frame acquisition of file media, retained rasters and
native glyph recipes while the preceding submitted frame executes on the GPU. The immutable CPU
products own their original request, settings, session identity and generation; stale or foreign
acquisitions cannot enter frame planning. Each acquisition keeps the existing source, descriptor
and decoded-pixel budgets, including authenticated retained responses. The raster service advances
once per frame in schedule order; immutable pixels and glyph leases keep the preceding frame valid
for observers. No next-frame GPU allocation or rendering occurs until the preceding output lease
is released. GPU submission, observers, encoding, progress and pause acknowledgments retain their
ordered frame boundaries. Diagnostic views use the sequential path because their fallback requires
GPU allocation.

Jobs may select an on-demand retained raster process instead of supplying frame manifests. Rust
owns the loaded project, frame schedule and ordered resource requests. The isolated Electron host
loads the same authored project identity and supplies font layouts and text/SVG/PSD pixels through
a nonce-authenticated loopback channel. Length-prefixed controls and separate binary payloads have
per-frame budgets, deadlines and cancellation checks. Native admission verifies request digests,
resource descriptors and pixel hashes before using a response; failed exchanges poison the provider.
Within the configured raster cache budget, Rust retains immutable verified descriptors as well as
pixels. At most one sixteenth of that budget holds descriptors. Later frames may reference only
hashes Rust explicitly advertises as resident and the host saw in the previous frame; eviction
requires a complete descriptor again. References resolve to the original owned verification proof,
then undergo the same current-frame scope and closure checks. New pixel readbacks wait for preceding
GPU submissions through their mapped buffers; immutable cache hits do not add a queue-wide wait.
The child process and its temporary profile belong to the job and are removed when it ends. This
boundary carries no host-authored scene plans and does not stage a complete job's raster frames.

Immutable native resource proofs share their validated descriptor, payload and exact admission-byte
charge across cache and registry owners. Repeated registration does not clone or canonicalize the
descriptor again. Each registry still checks its own budget, dependency pins and leases; eviction
releases that registry's charge without invalidating another owner's proof.
Native nested plans retain their validated typed metadata with the encoded resource bytes. The
constructor owns encoding and validation; callers cannot attach mutable metadata to an existing
proof. Frame traversal shares these immutable plans while rechecking caller limits and complete
resource closure. Identical caller limits reuse the constructor's validation proof; any different
limits revalidate metadata and lengths. External byte resources still undergo full decoding, and
explicit round-trip audits reconstruct the same wire bytes. Retention belongs to the bounded frame
resource bundle.

`FfmpegExportBackend::mux_h264` accepts a bounded sequence of ordered Annex-B access units from
the native encoder. It copies H.264 into MP4, assigns rational frame timestamps and BT.709 limited
range metadata, and optionally encodes the supplied audio track as AAC. Raw-frame export and
encoded-packet muxing share the bounded channel, explicit completion marker, concurrent stderr
drain and cancellation monitor. The final packet is withheld until producer completion; short,
extra or interrupted streams cannot publish a partial file. Atomic publication preserves an
existing destination and removes the owned temporary on failure.

`aster-render-cli export --project ... --composition ... --out ...` builds a bounded frame schedule
from the native project and optional output size, rational rate and range overrides. Native audio
mixing uses 48 kHz stereo chunks with the existing limiter and pads the final rational frame interval
with silence. A job-owned float WAV supplies the muxer and is removed after completion or failure.
`--no-audio` omits that WAV and the output audio track without removing audio inputs from native
evaluation, so audio-reactive visuals retain the same frame results.
Rendering and encoding use shared GPU NV12 surfaces when available, with an explicit in-process
NV12 readback fallback. Packet indices, timestamps, durations and encoder drain receipts are checked
before the producer can finish the mux stream. Optional newline-delimited stdin controls pause,
resume or cancel the job; malformed controls or a disconnected controller cancel it. Pausing holds
the next acquisition boundary without changing the schedule. A pause control may include a numeric
`request_id`; the processing thread emits `{stage: "paused", request_id}` only after reaching a
safe boundary, including audio staging. Controllers must match that identifier to their outstanding
pause request and ignore stale receipts after resume or cancellation. Notifications run outside the
control lock, and cancellation releases a paused worker without publishing an unfinished MP4.
The production application invokes this authored-project export path through `NativeQueueHostFactory`.
Native capability failures fail the job; the queue does not select a retained TS renderer.
`--format png` exports one frame (the default frame count is one); `--format png-sequence` exports
the selected range into a new directory with zero-based `frame_000000.png` member names. Both reuse
one native project session and the same pause/cancel controls. Image output preserves RGBA and accepts
odd dimensions independently of MP4's NV12 constraints. Lossless PNG delivery reads the final GPU
texture inside the native process and encodes it there; full-frame RGBA never crosses Electron IPC.
The bounded output transaction publishes only after all frames succeed, preserves existing outputs,
and removes its private staging on failure. Receipts bind each PNG and decoded RGBA hash to its exact
rational frame time, dimensions, project and adapter. PNG exports do not mix or encode an audio track,
while audio-reactive evaluation still uses the native audio inputs.
`--start-frame` evaluates each absolute index directly through the rational output rate, matching
the TS export clock bit for bit; it is mutually exclusive with an arbitrary `--start` time offset.
Optional `--witness` and `--witness-frames` capture bounded RGB, NV12 and native-plan evidence from
the actual export loop. Memory-input witnesses hash the exact bytes submitted to the encoder;
shared-input witnesses explicitly identify the same-frame conversion mirror. The atomic witness
manifest binds project hashes, adapter, frame times, output MP4 hash and transport. Failed or
cancelled exports discard unpublished witness staging. Capture itself grants no quality verdict,
and ordinary exports perform no diagnostic RGB readbacks.

Surface cache generations are independent of the root project revision: a newly loaded TS surface
renderer starts at generation one, even when the root snapshot revision is zero. Native recursive
surface plans carry the admitted surface generation while root plans retain the snapshot revision.

The diagnostic `pnpm parity:capture --plan-references` mode captures the retained TS evaluator at
all declared case frames and 64 deterministic subframe times per case. A SHA-256-derived schedule
binds the case and authored project, with sample indices kept separate from exact evaluation times.
The capture uses the existing production export-plan path, including its resource readiness barrier,
without reading final beauty pixels. Each isolated run records the loaded project snapshot, resource
payloads, native IR validation receipts, host/font identity and before/after source inventories; only
complete authenticated runs publish a plan-reference manifest. These artifacts establish TS plan
references and cannot substitute for native evaluation, pixel acceptance or headless export gates.
Owner project snapshots are retained in a unique system temporary directory outside the checkout;
the manifest binds their exact external paths and content hashes. Ordinary corpus snapshots remain
inside the isolated run. Missing or changed external snapshots invalidate reference admission.

`plan-diff` authenticates both resource closures and follows only typed nested-plan references. It
compares metadata exactly, preserves plan aliasing through a bijective hash mapping, and applies the
bounded float tolerances to declared numeric lanes. Resource content outside nested plans remains
exact, including shaders and pixel payloads. Mixed binary layouts keep IDs, counts, opcodes, modes
and discrete controls exact. Reports identify the first differing metadata path or blob byte offset;
comparison failures return exit code 1, while malformed inputs return exit code 2.

Native project verification evaluates authored projects through `render-project`, supplying only
frame addresses, bounded settings, plugin locations and the raster-only provider. Frozen TS plans
are independent comparator inputs. G2 binds every declared and seeded sample to its native receipt;
G3 accepts only the PNG manifest produced by that authenticated project run. Headless G5 invokes
`export --project` independently, compares complete segments against frozen pixels and retained TS
quality, and verifies audio, pause, cancellation and temporary-file cleanup. Encoded structural
alternatives use the actual export's RGB and NV12 witnesses, with separate numeric checks and
self-reviews; supplied-plan replay checkpoints cannot establish native project export coverage.

Frozen project references retain their original complete producer inventory independently of the
current application host. Audits preserve matching bytes from the checkout and recover changed host
files only from the recorded Git commit with the exact original SHA-256. Historical renderer files
and shader fragments still match the checkout; the paired benchmark driver and type-only presenter
import are explicit host exceptions. The shared shader catalog may add native programs but cannot
alter a historical definition. Reports distinguish original producer files from current candidate
sources. A historical capture validator's original identity is retained even when its executable
is no longer available; an existing mismatched executable still fails. Historical validation never
grants current acceptance: G2's current native `plan-diff` independently decodes every reference plan
and resource closure. Candidate checkpoint binaries remain mandatory and authenticated separately.

After native glyph admission, a comparison-only plan may name an already reviewed native/TS text
pair identically. Admission reauthenticates the completed text gate, per-glyph layout, physical fonts,
project identities and both exact GPU pixel hashes. The original Rust plan, resources, PNG and failed
raw comparison remain intact. Only the qualified source, raster frame and pixel leaves are mapped;
affected typed stage buffers are rehashed without changing headers, binary payloads or other values.
The ordinary strict plan comparator then checks this separate view. Unsupported nesting or temporal
glyph structures fail closed. Checkpoint audits reconstruct the view from original artifacts and
authenticate every retained comparison command; they never trust a stored substitution alone.

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

Frame and sequence export use immutable native project sessions with exact rational timeline addresses.
Electron's native queue worker prepares authorized media and plugin snapshots, then starts a Rust
output process for each module. Rust owns evaluation, wgpu rendering, PNG output, NV12 conversion and
FFmpeg video/audio encoding. PNG receipt journals and encoded output receipts authenticate staged
files before atomic publication. Pause, resume, cancellation and cleanup remain correlated to the
persistent queue lease. See [Background render queue](RENDER_QUEUE.md) for output and lifecycle details.

The former browser readback pipeline and hidden RenderHost remain available to explicit reference
tooling. They are excluded from the normal application frontend and are not registered or launched
by application startup. Production capture and automation use native preview readback or native queue
exports; Canvas compatibility remains available for non-production preview.

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
The native renderer binds the plan's exact content-addressed LUT using the same shared fused shader.
Cubic packed textures are validated before admission; half-float samples remain linear, including
HDR and negative values. A device-owned cache shares a LUT across root and child scenes, retains
unchanged uploads and evicts unused entries under the shared image/surface/frame budget. Entire
frame demand is admitted before LUT eviction; missing resources, non-finite samples and invalid
shapes reject explicitly. Native receipts expose upload, hit, eviction and resident-byte counts.
Native layer effects derive blur and glow mip counts from the supplied operation radii. Allocation,
transient admission and per-layer recording share those counts; one guard level covers fractional
sampling and LOD rounding without rewriting the supplied shader uniforms. When both chains are
needed, a native-only two-target seed pass shares the source taps and applies the bright-pass before
glow accumulation. Later levels retain separate textures and the existing downsample shader because
the thresholded and unthresholded signals differ. The browser path keeps its existing passes.
`SurfacePostPlan` validates transported surface controls, and a retained `SurfacePostPipeline`
records selection isolation or vector motion blur directly from GPU-resident HDR, integer object-ID
and motion-vector attachments. It checks attachment formats and dimensions before recording and
preserves captured skips. Complete native frames connect primary auxiliary attachments to these
effects and the existing display AA pass. Unsupported diagnostic routes remain capability gated.
The shared post-process shader uses one source sample when blur, glow and chromatic aberration are
all zero, skipping the chromatic offset samples and nine-tap blur. A single uniform branch preserves
the original active effect path and keeps the source texture on the GPU.

Native mesh draws consume supplied material scalars and content-addressed RGBA16F environment
textures through the shared material WGSL. Environment textures share the budgeted image cache;
material controls and texture generations participate in post-effect layer keys. Material pipelines
are initialized only for active draws. Directional and spot shadows use the supplied map geometry
and linear comparison filtering, matching the retained browser path. Inline PNG, JPEG and WebP
normal maps are decoded behind `aster-media-native`, authenticated separately from their derived
pixel resources, and uploaded as linear RGBA8. A bounded session cache retains decoded pixels;
the existing GPU image cache retains texture generations. PNG uses the packaged FFmpeg snapshot
boundary; WebP uses the pure Rust `image-webp` decoder with browser-compatible bilinear chroma
and alpha handling. On Windows, JPEG uses the built-in Microsoft WIC codec through a bounded
in-memory stream, with no color transform. Its COM scope preserves the caller's apartment. Other
platforms currently reject JPEG normals. Animated WebP uses its first subframe on a transparent
canvas, matching ImageBitmap rather than advancing with composition time. Inline decoding grants
no filesystem media access.

Native root scene generators authenticate their invocation and shader resources against the frame
header and realized capacity. The supplied shared WGSL graph runs compute directly into GPU
instance and indirect-draw buffers, followed by ordered beauty draws. Program pipelines are shared
by graph identity and retired when absent from the active frame; instance buffers are initialized
from each time-addressed invocation, without CPU readback. Naga preserves invariant position
outputs to prevent native arithmetic reassociation from changing thin-triangle raster coverage.
Generator and motion shaders lower normalization to vector/length division and bound finite float
products before later additions. This avoids backend reciprocal-square-root and contraction choices
changing particle coverage or reconstruction. The shared FXAA luminance calculation bounds its
display-UNORM contributions before summation so luminance/alpha ties retain the same edge direction.
Native post processing also bounds finite products in the fragment entry before color quantization.
Shader helpers and the shared source remain unchanged; this preserves the TS rounding boundary
whose one-code-value difference can otherwise change the subsequent FXAA edge selection.
The buffer allocation budget includes generator context, parameters, instances, indirect arguments
and audio analysis. Root and recursive child generators share one authenticated audio record and
one GPU audio buffer per root frame, including invocations that omit a redundant audio payload.
Conflicting supplied records fail before GPU execution. Every frame recreates this binding from
its supplied record or defined silence, preventing analysis from leaking between frames. The audio
allocation is budgeted once across all scenes. Child-first surface execution uses the same cached
programs and GPU generator executor as the root. Captured unavailable child generators retain their
validated identity and resources but must be absent from the executable command closure.

Supplied auxiliary generator identities select the same GPU instance and indirect buffers used by
beauty. Requested variants compile a five-attachment MRT pipeline lazily, preserving graph cull and
depth state and supplied draw order after geometry. Motion reconstruction, depth effects and buffer
visualization consume these attachments without another compute dispatch or CPU readback. A plugin
without an auxiliary descriptor remains beauty-only; referencing it as an auxiliary draw is an error.

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
These native utilities back the production preview and export renderer.

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

Native primary auxiliary execution consumes supplied scene vertices, unsigned integer IDs and motion
attributes through the shared five-target MRT shader. Target allocation is admitted against a byte
budget before GPU writes. Geometry and alpha-tested media share the captured depth ordering, and
cleared plans clear every attachment. This pass provides the GPU inputs for surface post effects;
complete root surface-output routing is supported. Transparency and depth-peel passes preserve the
captured geometry fallback while generators contribute primary depth and residual beauty color.

Native surface output validates the final mode against the supplied post-effect stage and binds
auxiliary draws to the same root geometry and cached media/precomposition generations. Ready effects
require valid attachments; captured skips still clear the final target before AA. The GPU budget
includes primary MRT textures, depth and attribute buffers before any frame allocation.


Native layer scratch attachments persist across frames with identical dimensions and blur/glow
mip counts. Sequential scenes may share these attachments because every layer clears or overwrites
them before use. Only descriptors required by the current frame remain resident; retired slots wait
for GPU completion before replacement. Their cost stays within the existing per-scene transient
budget. This allocation reuse is independent of the optional rendered-result cache.

Generator instance buffers also reuse bounded, same-sized allocations after GPU completion.
Generic programs clear recycled storage once per frame. The canonical particle program may omit
that clear only when its complete compute, beauty and auxiliary shader sources and entry-point
contracts match the embedded catalog. Validated dispatch and indirect arguments ensure every drawn
instance is overwritten, including invisible particles; unused capacity is never drawn. Plugin names
grant no exemption, and modified programs retain zero-initialized storage.

The native isolated-layer cache retains post-effect RGBA16Float outputs on the GPU. Keys contain
ordered evaluated geometry, lighting, effect uniforms and operations, pyramid settings, LUT identity
and media frame/pixel generations. Audited time-independent operations may omit the unused time
lane when grain is zero; all other programs retain exact time. Recursive surface fingerprints include
child generations, ordered draws, clear/load/store semantics and effect composition. Aliases resolve
to the same generation; unknown dependencies or scenes without an initial clear remain uncached.
Adjustments remain uncached. Cache hits skip layer geometry and effects but composite against the
current backdrop. Optional admission reserves space within the total renderer budget, retains unused
valid generations by recent use when space permits, and falls back when no entry fits. Required
inputs take priority; pressure retires old GPU entries before replacements are allocated. Pending copies become
valid only after successful GPU submission; abandoned encoders cannot publish a cache generation.
`render-plan --layer-cache-bytes 0` disables reuse for diagnostic comparisons. Receipts expose
allocation, hit, miss, store, eviction, active-entry and resident-byte counters.


Native isolated effect passes can use conservative pixel scissors derived from the supplied clip-space
triangles, with raster/filter guard pixels and shader-specific alpha padding. Admission currently
covers neutral base controls, bounded posterize/tint/channel color operations, LUTs, outer glow and
stroke; other programs and adjustments retain full-frame passes. Targets still clear in full and
composition still uses the current backdrop. Empty regions clear without drawing. The diagnostic
`--full-effect-regions` switch restores full-frame execution; receipts count actual isolated shader
passes and full/drawn pixel areas separately from cache hits.

SSAA keeps isolated effects at the render target resolution. A GPU experiment evaluating blur and
outer glow at output resolution, then reconstructing RGBA16Float before display and SSAA, changed
edge coverage and exceeded pixel acceptance limits. That strategy remains test-only as a rejection
control. Any future reduced-frequency decomposition must preserve high-resolution coverage and prove
parity before becoming an execution path.

The native renderer CLI also provides a bounded long-lived `serve` session. Its control schema and
binary framing live in `aster-render-ir`; a content-addressed registry retains supplied resources
across plan checks. Frame admission releases temporary decoded normal textures after validation.
`aster-encode` owns the Windows Media Foundation boundary: it enumerates hardware transforms for
the renderer device's exact DX12 LUID, configures NV12/H.264 media types, and requires ordered
Annex-B test frames with successful drain. COM objects and activations are scoped to the worker
thread and shut down on failure. Peak-constrained VBR explicitly binds mean and peak bitrate to
the job; codec property readback before and after media-type negotiation rejects driver overrides.
Asynchronous MFT events use `BeginGetEvent`/`EndGetEvent`, with one pending notification and
only the event type or error crossing into the render thread. Qualification and production share
one streaming lifetime; the first sample after drain declares a discontinuity.
The authored-project export worker uses this encoder qualification before native delivery.
Electron validates complete output receipts and publishes the job's output set atomically.

On macOS, `aster-macos` owns the thin IOSurface, Mach-port and VideoToolbox platform boundary.
Apple framework calls use the `objc2` family of Rust bindings and retained resource wrappers;
Mach transport uses `mach2`. The optional `node-addon` feature exposes the same receiver through
stable Node-API in a Rust `cdylib`, without a separate C++ build chain.
`aster-renderer` wraps private BGRA IOSurfaces as Metal textures and charges their aligned
allocation sizes to its GPU budget. Preview uses a bounded pool with the same immutable lease
rules as Windows. Only Mach send rights cross the process boundary: a private, randomly named
receiver checks the kernel audit-token PID, sequence, dimensions and pixel format before giving
Electron a process-local IOSurface reference. The Node-API module lives only in the main process;
renderer IPC receives a VideoFrame, never a native pointer. Electron's final GPU-reference release
acknowledges the producer lease before a slot can be reused. Failed or closed sessions retire the
receiver and all outstanding native references.

Authored-project MP4 export on macOS copies completed Metal output into one reserved BGRA
IOSurface and passes it directly to a hardware-required VideoToolbox H.264 session. No final
pixel data is mapped to the CPU. The initial implementation drains each submitted frame before
reusing its surface; this bounds memory and preserves ordered rational timestamps at the cost
of encoder parallelism. Compressed samples become bounded Annex-B packets for the existing
FFmpeg mux/audio and atomic-publication path. Receipts identify `iosurface-shared` transport
and the VideoToolbox hardware encoder. Windows keeps its DX12/NV12/Media Foundation path;
Linux native preview and hardware export remain unavailable.

`NativeRenderer::prepare_nv12` reserves a fixed-size conversion slot before export frames are
rendered. The shared WGSL conversion reads display BGRA on the renderer device and packs BT.709
limited-range NV12 into GPU storage. A retained staging buffer supports the in-process readback
fallback without transporting final RGBA through Electron. Both buffers count against the GPU
budget. The converter checks even dimensions, device limits and source format, and unmaps the
staging buffer on success or failure. The packed rows use the GPU texture-copy alignment; the
readback fallback removes row padding before encoding.

`prepare_shared_nv12` additionally reserves a bounded pool of shared DX12 NV12 resources, including
their actual device allocation sizes in the GPU budget. Each resource is imported as two copy-only
wgpu plane aliases. Conversion and plane copies complete before a D3D11 consumer receives the
handle; this path maps no pixel data. An owned lease retains the planes and handle, blocks slot
reuse, and survives renderer shutdown. Failed copies retire their slots. An unused pool can be
released after GPU completion when capability selection chooses the readback fallback.

The hardware encoder creates a D3D11 device on that same LUID and binds its DXGI device manager
only to D3D11-aware transforms. Shared handles become DXGI sample buffers without pixel mapping.
The Radeon 780M (1002:1900) driver 32.0.21030.2001 is excluded from shared input because its
adapter-selection trace can access invalid memory before the first sample. Exact adapter and
driver identity checks return an explicit capability error before activation. Callers retain native
NV12 conversion and hardware H.264 encoding through memory input and report the fallback reason;
other adapters and driver versions still qualify shared input normally.
Tracked-sample callbacks and matching encoded packets jointly retire frame leases, so early sample
release cannot expose a texture still needed by an outstanding encoded frame. The pool reserves
one preparation slot in addition to the configured in-flight bound. GPU probe samples stay alive
until explicit transform shutdown and have a separate total byte limit. Both the transform's
`IMFShutdown` and activation shutdown are invoked before releasing input/device ownership.

The diagnostic sidecar export stream connects supplied-plan rendering, packed NV12 and a retained
hardware H.264 transform. `aster-encode` owns asynchronous input credits, bounded in-flight frames,
bounded packet batches, ordered timestamps, drain and cancellation. Frame durations are differences
of absolute rational timestamps, avoiding cumulative drift for fractional frame rates. Hardware
activation, output format and a short encoded-frame proof must succeed before job frames are
accepted. The qualified transform is retained and flushed across that stream boundary; stale probe
events and packets cannot enter the job stream. Failure closes that stream, and encoder input never crosses an Electron pipe.
Only metadata and compressed Annex-B packets leave Rust. Electron's `NativeRenderClient` uses
one bounded request/reply transaction at a time; child failure, timeout or disposal releases
blocked writes and terminates the worker. `NativeExportSession` checks packet order, rational
timestamps and drain before the existing MP4 session stream-copies H.264 with the audio pipe.
Clean sidecar shutdown precedes atomic publication. The retained diagnostic broker verifies the
actual shared transport before selecting native; a startup failure allows one fresh-process
hardware qualification with native NV12 readback and a recorded transport reason. The final video
submission drains tail packets before waiting for PCM, breaking the video-EOF/audio-pipe wait cycle.
The broker verifies the
actual retained encoder before selecting native, then admits and seals every frame before opening
the MP4 mux. Immutable scope, revision, composition, exact time, size, AA and color pipeline are
checked against each native admission response. This supplied-plan comparison route supports one
H.264 MP4 output and retains its historical whole-job TS fallback. It is excluded from production
bundles. Production jobs use authored-project Rust evaluation for every supported output module.
`planExportFrame` stops TS execution after bundle construction and media/raster preparation,
without recording the final scene/output graph or reserving its readback. It shares the exact
resource barrier and retained media ownership with diagnostic capture, but captures only raster
pixels. File-media identities resolve through the sidecar's immutable native authorization grants.
Native-only video planning reads container metadata once for extent and duration, evaluates the
existing biased source clock, and supplies that target for native frame selection. It preserves
Chromium's truncated microsecond upload timestamp and the TS seek-tolerance hold behavior,
including its initial zero clock, in the plan descriptor. It does not seek,
decode, validate browser upload compatibility or copy video pixels. Extent-matched planning handles
cannot be read through the media registry. Switching to TS rendering recreates a decoded generation;
Rust still validates source grants, stream metadata, exact frame identity and pixels before admission.
The native capture adapter checks raster coverage, identity, hashes, layout and aggregate bounds,
then serializes owned plans/resources. It does not repeatedly execute the TS bundle reader over the
whole graph. Rust resource installation and whole-job frame admission remain the authoritative
semantic validation boundary before native selection; diagnostic TS capture keeps its full reader.
The host overlaps preparation of at most one owned next-frame packet with ordered native admission.
Each packet retains the 64 MiB transport limit; no second admission or further capture starts until
both operations settle. Pause, cancellation, capture failure and transport rejection drain the
in-flight pair before changing routes or disposing the renderer. All frames still pass admission
before native selection or mux creation.
Retained raster capture packs texture regions into at most 16 MiB GPU readback batches, splitting
large textures at row boundaries and stripping padding into the original tightly packed payloads.
The frame retains its existing 64 MiB pixel budget; native digest concurrency is capped at 32.
Every mapping is unmapped/destroyed on completion or failure, and capture leases remain pinned
through all copies. This removes per-raster GPU submission/map waits without changing pixels.
Native plan capture additionally retains up to 16 MiB / 256 captured raster inputs, keyed by both
authenticated frame hash and exact GPU texture generation. Unchanged rasters avoid repeated GPU
readback. Eviction bounds memory, callers receive owned byte copies, failed captures publish no new
entries, and renderer disposal invalidates pending retention. TS diagnostic capture remains uncached.
The native cache retains opaque verified snapshots with private pixel ownership. Attachment copies
each genuine snapshot once and reuses its completed hash verification. Ordinary captures still pass
independent hash checks in drained batches of at most 32. Layout, declared coverage and aggregate
capture/transport bounds precede attachment on both paths; caller mutation or transfer cannot alter
the cache or a pending frame.
Route diagnostics report aggregate preparation, resource transfer, native render/encode and identity-check
times without retaining per-frame timing arrays or changing output acceptance.
`NativeFrameAdmission` retains bounded resource digests and frame counts after each owned frame
passes native validation and compressed storage. Reused identities with changed contents fail
before native side effects; sealing requires every declared frame. Production admission does not
persist unused raw plans or pixels. The diagnostic `NativeExportSpool` retains authenticated raw
replay with bounded, deduplicated storage. `NativeResourceWindow` retains only the current dependency closure and transfers
up to 64 ordered operations per bounded transaction; each acknowledgement keeps its own request
identity. Video decoding retains private source snapshots and presentation indices under separate
byte and entry limits, while rechecking source grants and content digests before reuse.
Retained supplied-plan admission renders and encodes once, then binds the reply's typed plan hash/header
proof to the immutable job. Cumulative admitted input is bounded to 31 GiB, with at most 262144
distinct resource identities and 64 MiB per owned frame. Private compressed packets are bounded to
1 GiB. Whole-job sealing requires every frame, valid rational packet
timing, complete hardware drain and clean sidecar shutdown. Only then does the mux replay hashed
compressed records with the existing audio stream and atomic publication. It does not decode media,
install resources or render the plans a second time. Late admission failures clear input identities
and remove compressed storage before complete TS fallback; cancellation drains pending work before cleanup.
One native video decode window retains at most 16 MiB and eight presentation-order frames by
default. Sequential requests reuse those bytes after grant validation; source switches and seeks
outside the window replace it. Single-frame and zero-byte settings disable lookahead. Each process
keeps the same chroma/color conversion, cancellation, timeout and output bounds; incomplete windows
are never retained, and private readers/processes finish before a replacement is published.
Native file/texture decoding
releases temporary CPU registry entries after admission or rendering while the native GPU caches
retain their own generations.

Native decoder grants are constructed in the main process from verified job-owned file leases and
authenticated embedded media. Renderer frame packets cannot authorize file paths. Inline content
has an aggregate materialization budget; sequence grants retain member frame identities. The native
broker owns these files, bounded spool, sidecar and mux through finish or cancellation. Pause stops
preflight/replay at frame boundaries, and cancel interrupts pending native calls out of band.
The packaged build includes `aster-render-cli`; Windows uses Electron's adjacent DXC compiler.
The retained reference bundle keeps the shared shader manifest and raw WGSL fragments in its GPU chunk.
Its eager catalog must not read shader inputs from an application chunk that imports the catalog
through a cycle; both editor and hidden RenderHost startup depend on this initialization order.

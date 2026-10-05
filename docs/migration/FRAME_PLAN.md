# Frame-plan transport

The renderer migration introduces an internal transport contract separate from the project file
format and plugin ABI. `aster-render-ir` owns the Rust types and generated
`schemas/frame-plan.v1.json`; `src/renderer/frame-plan/` implements the corresponding TS validation
and DataView codec. The production beauty renderer remains the source of pixel behavior while its
evaluation and execution responsibilities are extracted.

## Initial scope

The initial contract is a `frame_plan_slice` with `contract_level: post_uniforms_slice_v1` and
`renderer_plan_complete: false`. It carries the existing 24-f32, 96-byte
`buildPostProcessUniforms` output and an explicit header slice. It is not a complete renderable
frame, does not contain a pass graph, and cannot establish M2 completion. Later extraction tasks
must add concrete typed data from production consumers; unknown fields and variants are rejected.

The header identifies a caller-owned snapshot scope and project revision, composition, exact time
and frame rate, output and internal render dimensions, AA mode, and the existing color pipeline.
Motion-blur shutter data and other evaluation results are added when their producers and consumers
are extracted. The snapshot scope distinguishes loaded documents, draft sessions and immutable jobs;
the revision comes from that caller's mutation boundary, never from renderer observation or a
per-frame content digest.

Composition IDs retain the project's existing nonempty string domain. Ordinary Unicode strings,
including long IDs and NUL, remain strings. An ID containing unpaired UTF-16 surrogates uses a closed
`utf16_units` representation so Rust can preserve its exact code units without replacement. This
alternative is rejected for well-formed strings. Container and metadata byte budgets still apply
at serialization boundaries; the snapshot scope has its own bounded identity rules.

Time has two closed variants: reduced bounded `rational` and `binary_rational`. The latter preserves
every finite binary64 request, including signed zero and subnormals, using a sign, odd integer
significand and power-of-two exponent. Production uses the actual request's bits, without deriving
an ideal frame-index time. Frame rates use a reduced `rational` when their exact ratio fits the wire
limits, or a `binary_ratio` retaining the two positive finite input scalars. This preserves existing
preview support for decimal rates without quantization.

`buildRootPostUniformPlan` copies scalar header inputs and produces the existing 96-byte root
post-process payload. `uploadRootPostUniformPlan` validates the supported slice and prepared target,
then uploads those supplied bytes, including a decoded view's offset. It receives no project,
composition or effect settings from which to recompute them. Media holds precede this boundary and
the existing command encoding follows it. Local execution uses typed data directly; canonical JSON
serialization remains a transport operation. Other passes still await extraction.

`scene_buffers_slice_v1` adds one owned scene blob and a `scene_buffers` descriptor. Its layout is
592 lighting bytes, then 160 bytes per evaluated vertex, followed by an optional 8-byte motion
vector per vertex. Vertex count and the motion flag determine the exact length, including empty
geometry. Plain draw records partition the vertex stream in order and carry instance, resource and
selection identities plus the existing three-dimensional shadow flag. IDs use the same lossless
string representation as composition identities. Geometry already contains evaluated camera
projection; the lighting bytes include evaluated light/shadow data and camera position. All f32
bits are preserved without adding new finite-value restrictions to the existing scene producer.

The root scene-buffer producer copies source data. The executor validates before GPU writes and
preserves lighting upload, shape capacity growth and shape upload order, including the pre-media-hold
position of these operations. Empty geometry omits shape allocation/upload. Actual beauty and
auxiliary ranges and selection identities come from decoded/plain draw records; shadow execution
uses only these records and the supplied shadow-enable flag. Auxiliary motion upload consumes the
supplied motion bytes. Material/resource adapters still pair planned ranges with live layer inputs;
complete depth settings, generator inputs and pass/resource planning are not covered by this slice.
All partial contracts continue to declare `renderer_plan_complete: false`.

`camera_parameters_slice_v1` owns evaluated camera pose, projection and optics without `Layer`,
authoring `CameraSettings` or animation objects. A closed `camera_parameters` descriptor carries
pose mode, projection kinds, depth-of-field and focus-lock flags, and iris shape. Its single 296-byte
`u8` blob contains 37 little-endian f64 scalars: position, point of interest, orientation and rotation
(four vec3s), projection zoom/orthographic size/near/far, then the 21 optics scalars in
`camera-layout.ts` order. The dedicated layout preserves JS evaluation precision before GPU f32
packing. It does not add value normalization to existing consumers. Root geometry/text expansion,
lighting, depth configuration and generator preparation consume reconstructed values from these
supplied bytes. Absence of an active camera retains the existing no-camera path. `SceneCamera` now
aliases only `EvaluatedCamera`; original transform/settings references no longer escape evaluation.

`temporal_text_samples_slice_v1` owns the evaluated samples for one text resource instance. Its
closed descriptor records canonical and unique sample counts, the exposure-only flag, and the
RGBA8 sRGB sample / RGBA16F linear accumulation / RGBA8 sRGB resolve formats. The byte blob contains
frame time and transparent weight as little-endian f64, followed by local-time/weight/time-bucket
f64 triples. TS and Rust validate the frame time against the header, finite values, bounded counts,
safe integer buckets and full shutter-weight coverage. Signed zero and exact sub-frame values are
preserved. Root preparation consumes supplied sample slices and exposure identities before text
raster preparation and geometry expansion. Temporal raster acquisition now freezes bounds, scale,
selected sample weights and canvases before a separate evaluator-free GPU uploader creates sample
textures, accumulation storage and resolve bindings. Resolved outputs carry raster identities and
participate in the root scene's hash bindings. The temporal cache and media registry share one physical
owner; pinned generations cannot be overwritten and retired pinned allocations remain budgeted until
release. Diagnostic capture now includes these resolved outputs. Individual sample textures now have
hash-addressed owners. The local `TemporalTextPassPlan` supplies output/sample hashes, dimensions,
formats and weights to an evaluator-free accumulation/resolve executor. It validates all bindings
and uniform slots before GPU writes; submission-scoped leases retain sample and output allocations.
`temporal_text_passes_slice_v1` transports this plan through FPLN/Rust. Its closed metadata owns
dimensions, formats, output hash and ordered sample hashes, all present in the resource table. Its
binary payload is an f64 transparent exposure lane followed by one exact f64 weight per sample;
transparent-only passes therefore still have an eight-byte payload. Both readers reject missing or
duplicate dependencies, invalid formats, nonfinite/out-of-range weights and incomplete exposure.
The production root supplies its actual frame header and executes the reconstructed slice.
The M2 pixel gate separately exercises actual temporal glyph accumulation in four exposure states,
compares the resolved outputs against frozen exact references and replays their captured resources.
G1 also round-trips full, partial, transparent and exact-bit pass fixtures through Rust and executes
their reconstructed hashes/weights against a recording GPU boundary. G3 also captures the actual
sample owners and pass, round-trips FPLN through Rust, and replays decoded sample textures in a fresh
page/device after destroying the producer environment. Only output descriptors, sample pixels and
the returned plan enter the consumer. Its GPU result must equal the frozen output. Complete
submitted-frame capture/replay remains open.

## FPLN encoding

The container begins with this 32-byte little-endian header:

| Offset | Width | Field |
| --- | --- | --- |
| 0 | 4 | ASCII `FPLN` |
| 4 | 2 | Container version, initially 1 |
| 6 | 2 | Header size, 32 |
| 8 | 4 | Metadata byte length |
| 12 | 4 | Blob count |
| 16 | 4 | Absolute start of the blob section |
| 20 | 4 | Complete container byte length |
| 24 | 4 | Flags, initially zero |
| 28 | 4 | Reserved, zero |

Canonical UTF-8 JSON follows at byte 32. Object keys are sorted recursively, arrays preserve their
defined order, and metadata uses bounded integers rather than floating-point GPU values. The
decoder validates typed metadata and compares its regenerated canonical bytes with the input.
Duplicate keys, unknown fields, alternate number spellings and noncanonical padding fail.

The blob section begins at the next 16-byte boundary. Descriptors contain relative offsets,
lengths and element types; relative offsets avoid making JSON length depend on absolute addresses.
Blob starts follow the canonical aligned packing order. All gaps and final padding are zero, and
all bytes must be accounted for. Arithmetic, counts, dimensions and allocation sizes are checked
against caller-supplied limits before indexing or allocation.

Rust owns one container buffer and borrows validated blob ranges from it. It does not allocate and
copy each blob while decoding. Re-encoding constructs a new header, metadata and container from the
validated types and borrowed payloads. TS honors each input view's byte offset and writes newly
produced scalar data explicitly in little-endian order. Existing binary payload bits are preserved,
including valid signed zeros. Nonfinite post-process values are rejected except signed infinity in
the time lane when it exactly matches conversion of a finite header time to f32. This preserves the
original producer's overflow behavior; NaN is always rejected. Root execution additionally binds
finite time-lane bits to the header and rejects resource references, additional slices, effect
operations, linear-output bypass, blur mip selection and masked-glow controls. Valid supplied effect
scalars, such as exposure, are uploaded without replacement.

The root post-process pipeline specializes the shared shader's `root_zero_operations` override to
`1`, using the executor's validated zero-operation contract to eliminate both effect loops at
pipeline creation. The shared default remains `0` for dynamic per-layer effect programs. Sampling,
grading and display expressions still consume the supplied uniforms; resource bindings and the
96-byte layout are unchanged.

## Resource operations

Plans refer to resources by content hash. Descriptors and bytes travel separately through typed
`PutResource` and `EvictResource` operations. Concrete transport kinds are `buffer`, `media_source`,
`media_frame` and `raster_pixels`. Media descriptors carry no pixel bytes or runtime handles. This protocol does
not yet implement media decoding, GPU allocation or sidecar message framing.

A source binds the source ID, opaque import content identity, media kind and authorization scope.
The broker must independently authorize and resolve that tuple; the descriptor grants no filesystem
access and does not mistake a legacy content identity for a cryptographic digest of the asset.
A frame binds its source hash, texture extent/format and an image, sequence, video or raster sample.
Sequence samples preserve the resolved safe-integer frame number and member file identity. Video samples retain both the
exact requested and uploaded `FrameTime`, including fractional-rate seeks and signed zero.
Raster samples declare a text/SVG/PSD origin and four exact bounds (x, y, width, height).
Each f64 is encoded as two little-endian u32 words, preserving fractional bits and signed zero
through JSON. Both languages reject nonfinite bounds and nonpositive extents. Ordinary text source
identity binds the prepared source/font revision, glyph signature and evaluated bounds.
Text bounds are layer-local ink bounds. SVG bounds describe the raster viewport in pixels; PSD
bounds describe the crop within the decoded pixel plane. Geometry continues to use the separately
evaluated scene payload, so these raster bounds do not reinterpret layer transforms or anchors.
SVG source identity includes the imported content revision and exact bucketed extent. PSD identity
includes the document revision, layer key, decoded extent and crop. The upload consumer uses the
prepared bitmap or explicit RGBA row layout without reevaluating source data.

`raster_pixels` carries tightly packed stored RGBA8 texture values in a separate binary payload.
Its descriptor binds the raster frame hash, exact extent and sRGB texture format. Admission checks
the byte count, content hash, matching frame/sample and resource budget. The payload pins its frame,
which pins its source; conflicting pixel payloads for one frame are rejected. A decoded upload
consumer verifies the authorization scope and uploads those stored values without source evaluation
or color conversion. The dedicated parity harness captures installed raster textures on demand,
reconstructs independent GPU owners from the resource table, and compares both GPU readbacks exactly.
It saves each resource generation once per case, with references from every captured frame. Source
owners remain retained through readback; failed mapping leaves the capture cache unpublished.
This verifies installed raster resource replay, separately from temporal sample/pass replay and
complete submitted-frame plan replay. The normal preview path performs no diagnostic readbacks.
The diagnostic `ir resources --payloads <directory>` reads bounded `<resource-hash>.bin` files and
validates binary admission before publishing its typed descriptor transcript.

Resource identity includes interpretation as well as payload:

```text
SHA256("ASTER_RESOURCE_V1\0" || u32_le(descriptor_length) ||
       canonical_json({kind, descriptor}) || resource_bytes)
```

Admission validates the descriptor, hash and explicit byte budget before changing the registry.
Repeated identical puts do not charge twice. Missing hashes, conflicting contents, insufficient
budget and eviction of pinned resources are typed errors. Plans must resolve all required hashes
before submission; resources remain pinned until that use completes. There is no implicit eviction
or substitution of missing resources with empty output. CPU transport accounting is separate from
actual GPU allocation and residency.

Media admission charges canonical descriptor bytes to the transport budget. Frame admission requires
an existing source of the matching media kind and retains it until the frame is evicted. A pinned
frame therefore also protects its source; an identical put does not add a second dependency pin.
The Rust CLI's `ir resources` command validates and replays descriptor-only media messages and emits
typed JSON for cross-language verification. It does not open media or render pixels.

The TS media adapter now snapshots image/video bindings for the root frame and pins their owners
through GPU queue completion. Replacement/sweep retires resources rather than destroying a pinned
texture. Unknown bindings, released leases and source/upload-generation mismatches fail before
submission; an explicitly captured pending binding still preserves the existing preview fallback.
The shared missing-media texture has its own retained owner. Abort releases unsubmitted leases, and
submission transfers ownership before invoking user readback/cache callbacks. Preparation now emits
typed `PutResource` source/frame messages and assigns their hashes to root draw batches; beauty and
auxiliary draws resolve those hashes against the retained frame table. Instance IDs are used only
while constructing these explicit references. Null references preserve the pending fallback; unknown
hashes fail before drawing. The magenta placeholder and not-yet-uploaded zero video texture have
explicit built-in identities. Sequence descriptors use verified member byte identities when available,
otherwise a labeled locator hash; PSD identities include the crop variant.

Small descriptors use synchronous SHA-256 through pinned MIT-licensed `@noble/hashes`, avoiding an
asynchronous hold at the synchronous encoding boundary. G1 compares it against WebCrypto and Rust.
A persistent GPU media registry now applies these messages against the installed binding identity.
It bounds descriptor bytes, registered physical-owner bytes, binding versions and active leases.
Repeated puts and authorization aliases count a physical owner once; replacing that owner under the
same content hash preserves each in-flight lease independently. Frame eviction requires no active
leases, and source eviction requires no dependent frames. Eviction unregisters the binding without
destroying an allocation still owned by the media cache. Retired in-flight owners remain included in
cache memory estimates until GPU completion. Obsolete unpinned generations and orphan source
descriptors are pruned between acquisitions and after release. Destroying the registry retains pinned
entries until their final release.

The scene-buffer slice carries `media_bindings`, ordered by unique `draw_index`. Each entry is either
`pending` or a `frame` with a content hash also listed in the plan's resource references. Out-of-range
or duplicated indices and absent resource references fail validation in both TS and Rust. Root
preparation adds these references after media readiness, preserving the owned geometry bytes, and
resolves every supplied media hash before encoding draws. A decoded FPLN can resolve the references
against newly admitted GPU owners without retaining the producer's handles. G1 exercises image,
sequence and exact fractional-video references with pending entries and repeated hash aliases.
This partial scene contract still lacks material/pass planning and complete captured-frame replay;
it does not establish a complete render plan. Temporal text and precomposition planning remain
separate tasks.

Ordinary text now has separate CPU acquisition and GPU upload boundaries. Acquisition preserves
font revision, sampled animation time, density buckets and glyph-state reuse; upload consumes the
supplied raster without access to the authoring layer. Geometry expansion receives copied bounds
after all shared-instance preparation, and shutter sampling captures the cache after precomposition
preparation to retain the existing timing. Ordinary text now registers raster descriptors and draws
through serialized scene resource references and GPU leases. Bounds are read from the typed sample.
A retained glyph result advances its lookup key without changing the installed pixel generation;
a new upload changes that generation and invalidates stale binding resolution. SVG/PSD production
adapters now register their prepared raster identities through the same scene resource references.
The upload consumer retains the external-image GPU path for SVG/stills and strided RGBA writes for
PSD crops. Captured binary pixel transport is available through the raster resource contract.
G1 jointly exercises Rust-decoded raster scene geometry and a fresh resource registry through the
production geometry-upload, raster-upload and draw-resolution consumers. Text quads use supplied
ink bounds; source geometry and authoring scenes are discarded before replay. Cloning the decoded
plan preserves uploads and bindings, and an evicted binding prevents replay. This proves the
ordinary raster scene slice. Temporal sample/pass replay is verified separately as described above;
complete decoded-frame replay remains required.

## Verification boundary

`texture_pixels` is an immutable packed texture resource with `dimension` (`2d` or `3d`), width,
height, depth and `format` (`rgba8unorm` or `rgba16float`). Rows and layers have no padding; half-float
lanes are little-endian. 2D depth must be one; 2D dimensions are bounded to 8192 and 3D dimensions to
256, with a 256 MiB payload ceiling. TS and Rust validate the descriptor, exact payload length and
domain-separated content hash. Registries account the binary bytes against their existing budgets.
Production LUT and HDR uploads consume prepared resources; names remain diagnostic labels outside
resource identity. HDR preparation strips worker row padding and writes owned little-endian binary16
lanes without changing their bits. Material preparation snapshots scalar settings and ready texture
hashes on geometry batches before encoding. Drawing consumes the supplied snapshot, preserves pending
fallbacks, and resolves owners by hash independently of draw IDs. Missing hashes and texture role
mismatches fail before binding. Retiring a duplicate owner invalidates bind groups that may reference
it. These snapshots use `material_bindings_slice_v1`: each `material_binding` has an instance identity,
tagged `fallback` or `texture` references for normal/environment, and a 24-byte `u8` blob containing
three little-endian binary64 values in order: normal scale, environment intensity, environment
rotation. Keeping binary64 preserves signed zero and subnormal values until GPU float32 conversion.
Both decoders reject nonfinite/out-of-range values, undeclared hashes, shared normal/environment
hashes, and nonzero environment intensity without a texture. Normal scale is in [-8, 8], intensity
in [0, 32], and rotation in [0, 1). Activity is derived from the supplied references and intensity.
Production preparation builds and reads this slice before drawing. Root and precomposition effects
also prepare LUT selections before command encoding. The CPU planner owns packed bytes, keeps the
last enabled loaded LUT, and reuses selections until checksum/size changes or the instance is swept.
Execution receives the supplied texture resource rather than an authored LUT. It installs a changed
hash before retiring the old GPU owner; identical content reuses the installed texture. Preparation
errors remain data until the existing effect diagnostic boundary consumes them. Complete effect
binding FPLN transport and independent LUT draw replay are now exercised by required gates. Material GPU execution is
separate from source acquisition: the production consumer takes a supplied binding plan and resolves
registered normal/environment owners. G3 independently replays six material draws after scene and
material FPLN plus both texture resource messages pass through Rust. It uses a new page/device and
compares raw RGBA16F pixels exactly against frozen pre-extraction outputs. This covers the material
draw boundary; complete captured-frame execution remains required.
The renderer encodes synchronously through submission, so asynchronous uploads
cannot retire resources midway through this local execution scope.

`encoded_texture` resources carry bounded compressed PNG/JPEG/WebP bytes with linear `rgba8unorm`
output and `color_space_conversion: "none"`. TS/Rust validate the encoding signature, format, 64 MiB
encoded-byte ceiling and descriptor/payload hash. Signature admission does not prove successful
decoding. The upload consumer owns bytes across asynchronous hashing, decodes without authoring URLs,
and checks the existing 4096px/64 MiB decoded normal limit before GPU allocation. Original bitmap
copy semantics are preserved; ordinary preview performs no texture readback.

G1 regenerates the schema to a fresh ignored path and compares it byte-for-byte with the expected
schema, without rewriting that expected file. It constructs real TS uniform payloads, encodes them,
invokes the current Rust CLI to decode and re-encode, and decodes the result in TS. The canonical
container and payload bytes must be exact. Independent Rust fixtures and malformed-input tests
exercise both implementations instead of accepting a child process that merely echoes its input.

Passing this transport gate proves the current closed contract only. M2 additionally requires
production `buildFramePlan`/`executeFramePlan` consumption of every pass, complete resource capture,
independent decoded-plan replay and whole-corpus exact pixels. Under the approved owner policy,
intermediate performance is informational and final native preview/export must outperform TS.
A partial slice or manually changed ledger flag cannot establish exit.

### Compiled layer effect slices

`layer_effects_slice_v1` carries one `layer_effect` with UTF-16-safe instance identity,
blend mode, layer/adjustment route, operation count, blur/glow flags and a declared LUT hash.
Its 4200-byte payload owns 24 f32 uniform lanes, 1024 f32 instruction lanes and one binary64
bright-pass threshold, all little-endian. Transport preserves instruction bits, including unused
NaN payloads. Readers validate target dimensions, linear output, count and glow control agreement,
blur LOD bounds and finite nonnegative threshold before GPU execution.

Root and precomposition producers compile before encoding. Consumers upload the supplied buffers
and resolve the supplied LUT without consulting authored effects or evaluating parameters again.
A zero-op adjustment retains the existing skipped behavior. Compilation/resource errors remain
explicit prepared failures and reach the existing render error boundary. Complete recursive pass planning remains outside this partial contract.

### Effect execution routing

`effect_execution_slice_v1` records each instance/layer identity, direct/isolated-layer/adjustment/skip
route, blend mode and explicit fixed/backdrop/replace/no-composite operation. A 16-byte u32 payload
owns fused effect/group, barrier and analyzed operation counts. Both languages reject inconsistent
blend/composite combinations and invalid bounded operation counts. The separate routing slice also
exists when no executable program is needed or a resource failure is deferred.

Root and precomposition preparation computes these decisions before command encoding, including
no-effect surfaces without a GPU effect renderer. Root empty adjustments are skipped; precomposition
backdrop-only adjustments preserve their pass interruption and zero-operation behavior. Consumers
read supplied routing and diagnostics; they do not inspect authored effect lists or rerun fusion
analysis. Executable routing/program pairs must agree on instance, route, blend and frame header.
The ordered scene stack and complete recursive pass graph remain subsequent extraction work.

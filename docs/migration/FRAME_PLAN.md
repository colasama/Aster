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
`PutResource` and `EvictResource` operations. The initial concrete resource kind is a byte buffer;
it does not claim support for media authorization, textures, meshes or sidecar message framing.

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

## Verification boundary

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

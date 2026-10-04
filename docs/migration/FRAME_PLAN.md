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

The header identifies project revision, composition, rational time and frame rate, output and
internal render dimensions, AA mode, and the existing color pipeline. Motion-blur shutter data and
other evaluation results are added when their actual producers and consumers are extracted.
Explicit rational inputs are reduced and bounded to the shared integer domains. Existing preview
requests accept arbitrary finite JS times; production integration must preserve them without
silently quantizing through the current bounded rational type. GPU time and effect values remain
in the original f32 payload rather than being reconstructed from header metadata.

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
including valid signed zeros; nonfinite post-process uniform values are rejected.

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
independent decoded-plan replay, whole-corpus exact pixels, and current preview/export performance
within the specified limits. A partial slice or manually changed ledger flag cannot establish exit.

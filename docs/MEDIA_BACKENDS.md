# Media Backends and GPU Interop Strategy

## Status and scope

This document describes both the current bounded compatibility paths and the remaining native-media
plan. Browser video may use hardware decoding internally, but decoded pixels still pass through a
persistent canvas and `GPUQueue.writeTexture`. `aster-video` owns backend-independent stream selection,
exact timestamps, color metadata, bounded caches, process-isolated FFprobe/software decode, and a
typed FFmpeg H.264/H.265 export backend.

The Electron MVP exposes silent SDR H.264 MP4 export. It keeps at most three WebGPU readbacks in
flight, sends packed BGRA/RGBA frames over a dedicated binary IPC method, probes a real NVENC frame,
falls back to `libx264`, and atomically publishes the completed MP4. It deliberately does not claim
zero-copy: the display-referred frame travels from GPU memory to CPU memory and is uploaded again for
hardware encoding. Project audio mixing, HDR/10-bit delivery, alpha video, packaged FFmpeg artifacts,
native platform decode/encode surfaces, and zero-copy interop remain future work.

The MVP keeps one project model and one rendering contract. Media backends are replaceable adapters;
codec, platform, and driver details must not leak into layer evaluation.

## Required backend contract

Every decode or encode adapter must report a capability record before a job is accepted. Capability
probing is per adapter and GPU identity, cached only for the process lifetime, and repeated after device
loss or driver change. A successful library load is not proof that a codec/profile/format combination
works.

```text
MediaCapabilities
  backend, adapter_id, driver_version
  codec + profile + level + bit_depth + chroma
  maximum coded size, maximum references
  accepted/output pixel formats and color metadata
  decode, encode, alpha, B-frames, lossless, HDR flags
  external-memory handle types and row/modifier constraints
  synchronization handle types
  measured_interop: zero_copy | gpu_copy | cpu_copy | unsupported
```

Detection has three stages:

1. Enumerate the platform API and FFmpeg codec/hardware configurations without allocating a project
   resource.
2. Create a tiny real decoder/encoder session for the exact profile and requested pixel format.
3. When GPU interop is requested, import one decoded surface, synchronize it, sample it in the render
   device, and compare a checksum against a CPU reference. Only this stage may advertise `zero_copy`.

The selected path and rejection reason are exposed in diagnostics. Selection is deterministic:
validated same-device zero-copy, same-device GPU copy, hardware decode plus CPU upload, software
decode, then an actionable unsupported error. A failed fast path is quarantined for that process so a
frame is not retried through a broken driver on every evaluation.

## Pixel and color contract

Compressed media is decoded to one of these explicit surface classes:

| Surface class | Typical formats | Use |
| --- | --- | --- |
| 8-bit YUV | NV12, `yuv420p` | SDR H.264/H.265 decode and encode |
| 10-bit YUV | P010, `p010le` | HDR/H.265 and high-quality intermediate input |
| 4:4:4 YUV | `yuv444p10le`, `yuv444p12le` | ProRes 4444 and chroma-preserving export |
| Packed RGB(A) | BGRA8, RGBA8 | compatibility and alpha interchange |
| Linear working | RGBA16F | Aster compositing and effects |

Plane stride, visible crop, chroma siting, range, primaries, transfer, and matrix coefficients are
mandatory frame metadata. Coded size must never be treated as visible size. Unspecified metadata uses
a documented container/codec heuristic and emits a diagnostic; it is never silently relabelled as
sRGB.

YUV surfaces are sampled by a conversion pass into premultiplied linear RGBA16F. The pass applies
range expansion, chroma reconstruction, YUV matrix, transfer decoding, and working-space conversion
in that order. Alpha is converted to linear coverage and premultiplied exactly once. CPU fallback must
match the GPU reference within the color-management test tolerances.

## Alpha video

H.264 has no portable alpha channel. Ordinary H.265/HEVC delivery also has no interoperable alpha
contract; vendor-specific auxiliary-alpha media must be capability-gated and must not become the
project interchange format.

The supported design should be:

- ProRes 4444/4444 XQ in MOV when the selected decoder reports an alpha plane or packed alpha and a
  conformance fixture proves preservation.
- Image sequences (PNG initially, EXR after its separate format work) as the lossless universal
  fallback.
- A paired color stream and grayscale alpha stream as an explicit Aster import representation. Both
  streams share a rational timeline, and a missing alpha frame follows the same deterministic frame
  hold policy as color.
- VP9/WebM alpha only behind fixture-based demuxer/decoder capability detection; ecosystem support is
  not uniform enough for a baseline guarantee.

Straight versus premultiplied input is an import option recorded in project state. The decoder adapter
returns straight alpha unless the source contract explicitly says otherwise; the conversion pass owns
premultiplication. Alpha conformance includes transparent pixels with non-zero RGB to catch halos and
double-premultiplication.

## Export codec strategy

| Target | Baseline path | Hardware path | Policy |
| --- | --- | --- | --- |
| H.264 | FFmpeg LGPL-compatible native encoder when available; otherwise a separately distributed, legally reviewed software encoder | D3D11/D3D12, VideoToolbox, VAAPI | 8-bit 4:2:0 SDR delivery; no alpha |
| H.265 | Optional, capability- and distribution-gated | D3D11/D3D12, VideoToolbox, VAAPI | 8/10-bit; warn about playback and patent/licensing constraints |
| ProRes | Platform-neutral FFmpeg encoder only after conformance and legal review | VideoToolbox where the exact profile is exposed | MOV; Proxy/LT/422/HQ and 4444 profiles are separate capabilities |
| PNG sequence | Existing lossless fallback | GPU render plus CPU PNG writer | Supports alpha; resumable by frame |

Encoder choice must never change timeline sampling. The renderer produces exact presentation
timestamps and bounded RGBA16F frames; a conversion stage produces the encoder's requested NV12,
P010, 4:4:4, or BGRA surfaces. Rate control mode, bitrate/quality, GOP, B-frame count, profile, level,
pixel format, color tags, and codec implementation are written into the export report.

H.264 and H.265 output are product capabilities only after muxing, audio synchronization, cancellation,
and conformance gates pass. Merely constructing an FFmpeg command is not implementation. Hardware
encoding is optional optimization: software output remains the correctness fallback, and differences
in rate control or bitstream are expected while decoded visual conformance remains required.

## Background export architecture

Background export runs in a dedicated worker process, not a renderer thread or the UI process. The UI
creates an immutable project snapshot, resolves asset identities, and submits a versioned job manifest
over length-prefixed local IPC. The worker validates the manifest and paths again, creates its own GPU
device and media sessions, and reports structured progress, diagnostics, and heartbeats.

The job has bounded queues between evaluation, GPU rendering/readback or interop, encode, mux, and disk
write. Backpressure propagates to rendering; frames are never accumulated without a byte budget. A
cancellation token stops new submissions, drains or aborts platform sessions, removes temporary
outputs, and leaves source assets untouched. The final container is published by atomic replacement
only after encoder flush, mux trailer, file sync, and validation succeed.

Jobs record project/content hash, Aster build, backend capability snapshot, adapter/driver, export
settings, completed frame, and errors. PNG sequences can resume only when hashes and settings match.
Inter-frame video starts a new temporary encode after interruption; appending to a partial MP4/MOV is
not treated as safe resume. Device loss permits one clean worker/device restart before deterministic
fallback or failure. Interactive preview has scheduling priority; concurrent background GPU work uses
explicit memory and in-flight-frame budgets.

## Platform decode and encode paths

### Windows

- DXVA2/D3D9 surfaces are a decode compatibility path, not the preferred interop architecture. They
  normally require a copy or legacy shared-surface bridge before a modern render device can sample.
- D3D11 Video/D3D11VA is the MVP native target because decoder availability is broad and FFmpeg can
  expose D3D11 hardware frames. Keep decode and render on the same adapter LUID.
- D3D12 Video is an optional newer path. It requires explicit resource states, queue ownership, and
  fence values; API presence alone is not a reason to prefer it over a validated D3D11 path.
- D3D11-to-D3D12 sharing requires shareable resources, compatible formats, and keyed-mutex/fence
  discipline appropriate to the bridge. Never sample a decoder-owned surface before its completion
  primitive, and do not return it to the decoder pool before render consumption completes.
- Hardware encode probes the exact vendor driver capability for codec/profile/pixel format. Windows
  edition codec packs are not assumed to be installed.

The long-term low-copy renderer needs a native wgpu integration that can safely import or copy external
D3D resources. Until that integration is validated against the active wgpu backend, the truthful label
is hardware decode plus CPU upload, not zero-copy.

### macOS

VideoToolbox creates decompression/compression sessions with an explicit pixel-buffer pool. Prefer
IOSurface-backed `CVPixelBuffer` in NV12/P010/BGRA as supported by the exact codec/profile. Metal
imports the planes through `CVMetalTextureCache`; the YUV conversion pass samples plane textures.
Lifetime ownership retains the pixel buffer until the Metal command buffer completes.

Synchronization is command-buffer ordered when decode completion has delivered the pixel buffer.
Cross-process background export uses IOSurface identities only with an explicit ownership protocol;
otherwise decoding and rendering remain in the worker. VideoToolbox may expose ProRes encode/decode on
some hardware and OS versions, so profile support is probed, never inferred from the platform name.

### Linux

VAAPI capabilities are queried per DRM render node and exact profile/entry point. Prefer DRM PRIME
export to DMA-BUF with reported fourcc, plane offsets/strides, and modifiers. The render adapter and
VA display must resolve to the same DRM device. Unsupported modifiers trigger a VAAPI GPU copy or
software transfer rather than guessing a linear layout.

DMA-BUF ownership includes explicit sync-file fences when the driver stack exposes them; implicit sync
is accepted only on a tested path and recorded in diagnostics. The consumer must finish before the
surface returns to the VA pool. Headless export must not depend on an X11 display. VAAPI encode is a
separate entry-point capability from decode.

## GPU interop matrix

`Zero-copy` below means that compressed decode output remains in GPU memory and is sampled without a
full-frame CPU round trip. A GPU color-conversion pass still counts as zero-copy. All cells require the
runtime checksum probe described above.

| Decode surface | Preferred render bridge | Synchronization | Expected tier | Required fallback |
| --- | --- | --- | --- | --- |
| D3D11 NV12/P010 | native D3D11 plane SRV or validated shared-resource bridge | decoder completion plus keyed mutex/fence; render completion before recycle | zero-copy or GPU copy | staged CPU planes |
| D3D12 NV12/P010 | native/shared D3D12 resource | state transition and shared fence value | zero-copy | D3D11VA, then CPU |
| DXVA2 surface | legacy D3D9/D3D11 bridge | legacy surface ownership | GPU copy at best | D3D11VA or CPU |
| IOSurface `CVPixelBuffer` | `CVMetalTextureCache` plane textures | decode callback plus Metal command-buffer lifetime | zero-copy | `CVPixelBuffer` CPU planes |
| VAAPI DMA-BUF | native Vulkan/EGL DMA-BUF import with modifier | explicit sync file where available | zero-copy or GPU copy | VA transfer to CPU |
| FFmpeg software frame | staging buffer/texture upload | queue ordering | CPU copy | unsupported only if allocation bounds fail |

Interop is disabled if adapter identity differs, handle import is unsupported, the format/modifier is
not sampleable, synchronization cannot be proven, protected content is present, or validation pixels
do not match. No platform backend may reach into wgpu internals without a pinned, reviewed integration
layer and device-loss tests.

## Packaging, patents, and licensing

Aster's distributed FFmpeg configuration must be reproducible and publish its configuration, component
licenses, and source-offer obligations. The default distributable build stays on the LGPL side: dynamic
linking where required, no accidental GPL-only filters/libraries, and no nonfree configuration. Enabling
`libx264`, `libx265`, or other GPL components changes distribution obligations and therefore requires a
separate build flavor and legal approval; runtime discovery of a user-installed encoder is also
reported explicitly.

Codec patent pools, royalty terms, geographic differences, app-store rules, and trademark/profile
naming are product/legal decisions independent of open-source library licenses. H.264, H.265/HEVC,
AAC, and ProRes distribution must pass a release legal review. Platform frameworks reduce integration
work but do not by themselves grant every distribution or content right. CI artifacts must identify
the encoder actually used and must never silently switch a release build to a legally different codec.

## Test and release gates

A backend or export target is enabled only when all applicable gates pass:

1. **Capability fixtures:** positive and negative profiles, 8/10-bit, 4:2:0/4:4:4, odd visible crops,
   maximum advertised dimensions, missing hardware, different-adapter rejection, and device loss.
2. **Timestamp conformance:** CFR and VFR files with B-frames, negative/start offsets, seeks, frame
   holds, and exact first/last presentation timestamps against rational references.
3. **Color conformance:** limited/full range, BT.709, BT.2020 PQ/HLG, chroma siting, HDR metadata, and
   GPU-versus-CPU conversion tolerances. Metadata round-trips through the output container.
4. **Alpha conformance:** opaque/translucent/zero-alpha pixels with non-zero RGB, straight and
   premultiplied sources, ProRes 4444 and paired-alpha fixtures, seek/cache behavior, and halo tests.
5. **Interop correctness:** runtime pattern checksum, adapter mismatch, unsupported modifier, fence
   ordering under a saturated surface pool, surface lifetime, cancellation, and device reset.
6. **Encode conformance:** decode exported media with an independent decoder; verify frame count,
   timestamps, duration, dimensions, pixel format, color tags, keyframe behavior, audio sync, and
   bounded perceptual error. Alpha is bit-exact or tolerance-gated as appropriate.
7. **Reliability:** 10,000-frame soak, repeated seek, bounded RAM/VRAM/cache, background worker crash,
   cancellation at every pipeline stage, disk-full handling, atomic publication, and no orphan process.
8. **Performance:** report decode, interop/conversion, render, encode, and mux median/p95/p99 separately.
   A zero-copy claim additionally requires no frame-sized host read/write in GPU capture or telemetry.
9. **Distribution:** automated FFmpeg configuration/license inventory plus a signed legal checklist for
   every shipping platform and codec flavor.

Golden fixtures must be small, redistributable, generated from documented sources, and accompanied by
expected probe metadata and pixel hashes. Driver-specific failures are kept as regression fixtures,
not broad vendor blacklists. Performance observations are reported, never encoded as flaky wall-clock
unit-test thresholds.

## Implementation sequence

1. Add an FFmpeg probe/software-decode adapter behind the `aster-video` contract and preserve exact
   timestamps and color metadata.
2. Add the background worker protocol and software H.264/PNG pipeline with cancellation and atomic
   publication before hardware optimization.
3. Implement D3D11VA, VideoToolbox, and VAAPI adapters with CPU-transfer fallbacks and diagnostics.
4. Add native external-surface interop one platform at a time, guarded by runtime conformance probes.
5. Add hardware encoders as optional adapters; compare their decoded output to the software reference.
6. Enable H.265 and ProRes only after capability, conformance, packaging, and legal gates pass.

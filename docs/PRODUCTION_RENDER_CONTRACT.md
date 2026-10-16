# Production Render Contract

## Native session admission

`aster-render-cli serve` accepts versioned JSON control lines followed immediately by each
declared binary payload. Request IDs increase within a session. Control length, payload length,
registry bytes and resource counts are bounded before admission. A framing error terminates the
session; a rejected resource or plan returns a correlated error without discarding other resources.
The request schema is `schemas/render-session.v1.json`.

`put_resource`, `evict_resource` and `check_frame` use the same content-addressed registry. Frame
checks use full native capability validation and release only temporary decoded textures they
inserted. `probe` matches the renderer's DX12 device LUID to hardware-only Media Foundation
encoder enumeration and checks bounded, ordered Annex-B test frames through drain. This proof
does not establish complete native export availability. Queue selection also qualifies the retained
encoder transport and admits the entire immutable job; quality, performance and application gates
remain required for migration acceptance.

Hardware encoding defaults to peak-constrained VBR. The mean and peak codec bitrates are set to
the job's requested bitrate, rather than relying on driver defaults or media-type metadata alone.
Codec settings must survive readback both before and after media-type negotiation; a mismatch
rejects that hardware candidate. Quality/speed and GOP controls remain optional diagnostic overrides.
The maximum quantizer defaults to 18 to bound coarse startup frames before the rate controller has
estimated scene complexity. This static codec limit applies to the whole stream, preserves the
requested mean/peak bitrate settings, and is verified through the same readback checks. An explicit
`--encoder-max-qp` overrides it. Candidate qualification rejects hardware that cannot retain the
limit; whole-corpus and owner quality, bitrate and throughput acceptance remain required.

The opt-in `--native-export` route adds `begin_export`, `render_frame`, `finish_export`
and `cancel_export`. A successful adapter probe precedes begin; each supplied frame is admitted
before GPU execution. Fixed-size NV12 remains inside the native process. Responses carry packet
metadata followed by the declared Annex-B bytes, with frame indices and rational 100 ns timing.
The encoder limits queued frames and bytes, rejects reordered output, and requires all requested
frames before successful drain. A request failure aborts the active export. Cancellation flushes
and shuts down the transform; subsequent frame/finish requests reject until another begin succeeds.
The host must discard a partial stream and may only publish after successful finish and mux.
`begin_export` first tries shared GPU NV12 surfaces with a D3D11-aware hardware encoder. If that
capability fails, it releases the unused shared pool and tries bounded in-process NV12 readback
with the same hardware-only encoder policy. `export_started` reports `transport` and an optional
`transport_reason`; no software encoder is selected. The diagnostic `--native-shared-export` and
`--native-readback-export` options force one route and are mutually exclusive with automatic
selection. Completed shared exports report all GPU input leases retired. These routes remain
experimental pending complete Electron integration and M8 acceptance.

`warm_frame` optionally executes a validated plan on the already prepared renderer before the
first encoded frame. It completes the selected shared-NV12 or NV12-readback conversion, releases
the result, and returns a `frame_warmed` identity proof with an unchanged encoder clock and no
binary payload. Warm-up never submits a frame to the encoder; it cannot change H.264 references
or consume measured frame indices. Requests after encoding starts fail and abort the export.
`NativeExportJob.warm` permits ten ordered, wrapping job frame addresses, authenticates each
proof against the immutable manifest and releases preparation resource leases before fresh
admission. Its duration and count are reported separately. Normal queue exports do not call it.

The Electron `NativeRenderClient` allows one outstanding request, owns outgoing binary data until
pipe completion, and bounds each reply before allocating its payload. Broken framing, rejected
requests, process exit and timeouts fail the client closed. Out-of-band disposal terminates a
worker blocked in native code. `NativeExportSession` checks ordered rational packet timing and
complete encoder drain, then waits for clean worker shutdown before the existing MP4 session may
publish. Its `native-h264` input mode uses FFmpeg stream copy, exact rational timestamps, the
existing Float32 audio pipe and atomic publication. It does not select an FFmpeg video encoder.
The render queue now exposes lease-correlated native preflight and replay requests. Every plan's
authenticated header must match the frozen job's scope, revision, composition, binary time,
rational frame rate, output/render extents, AA and color pipeline. The actual `begin_export`
transport is qualified during preflight, before opening an MP4 mux, so initialization failure can
reject native selection without producing output. A shared transport startup failure permits one
fresh-process, hardware-qualified native NV12 readback attempt with a recorded transport reason;
cancellation prevents that retry. Every frame must pass before sealing permits
`startMp4`; native replay supplies frame indices only and rejects raw pixel messages. One H.264
MP4 output is currently eligible. Unsupported output sets, preparation errors and failed admission
select the complete retained TS job and log a concrete reason. Failures after output starts never
switch renderers midstream. Queue admission performs decode, render and encoding once per frame;
the reply authenticates the exact supplied plan and validated frame header. Compressed packets stay
private until all frames pass, encoder tail packets drain and the sidecar shuts down. The last
replayed video input forwards those retained tail packets before waiting for PCM, allowing FFmpeg
to drain short audiovisual exports. Publication still requires complete audio, packet counts and
a successful mux exit.
Packaged application checks cover these routes; full corpus/owner quality and performance remain
separate required gates.

`NativeFrameAdmission` keeps bounded resource digests and frame counts without persisting raw
plans or pixel buffers. It owns each IPC frame before admission, rejects changed contents under a
reused resource identity, and records a frame only after native validation and compressed storage
succeed. Sealing requires every declared frame; cancellation drains pending work before cleanup.
The diagnostic `NativeExportSpool` retains authenticated raw replay for its independent checks.
`NativeResourceWindow` evicts prior-only resources before installing the next dependency closure,
so a long job does not grow the sidecar registry without bound.
The queue bounds cumulative admitted input at 31 GiB, distinct resource identities at 262144 and
each frame at 64 MiB. Only resource digests survive admission; private compressed replies stay
within 1 GiB. `NativeEncodedSpool` authenticates sizes, packet order, rational timestamps and hashes;
it becomes readable only after a complete hardware drain. Queue replay uses these compressed bytes
instead of reinstalling raw resources and repeating native decoding/rendering. A late admission,
drain or storage failure invalidates the whole private job before any MP4 mux is opened.

`serve` also accepts the native media authorization manifest and packaged FFmpeg/FFprobe options
used by supplied-plan rendering. Checks and exports decode file media through the same native
media cache. Temporary decoded entries are retired after each request, including admission
failure; caller-owned identical resources are preserved. Cache hits share immutable verified pixel
resources with these temporary entries, avoiding repeated pixel copies and hashing without changing
wire validation, authorization or residency limits. Missing grants and supplied file-media
pixel overrides are rejected when native file decoding is enabled.
The Phase A media producer retains one verified source/frame identity pair per live media owner.
It reuses hashes only while every descriptor value matches; changes to authorization scope,
source identity, raster bounds, texture extent or video clocks produce fresh identities. Returned
messages cannot mutate the retained pair. The GPU registry compares repeated puts against its
private verified descriptor before skipping hashing and byte accounting, while still checking
the current binding generation, retirement, budgets and leases on every registration.
Native raster assembly snapshots the declared frame before asynchronous readback and gives the
capture callback a separate copy of its required media descriptors. The bounded raster cache keeps
opaque verified pixel snapshots while the exact retained texture generation survives. Private bytes
and a runtime-guarded constructor prevent mutable packets or forged hashes from becoming proofs.
The GPU lease is released after readback and initial verification. Assembly copies each proof once
into its transferable packet, reusing only its content verification; ordinary captures still undergo
hash verification. Layout, declared coverage and aggregate resource limits precede every attachment.
Caller mutations or transfers cannot change cached bytes, a pending frame or its published packet.
Generated plan resources reuse the hash computed over their freshly encoded owned bytes; ordinary
external resource insertion still checks its message and payload. Synchronous SHA-256 consumes the
same domain header and exact payload view in segments, avoiding a temporary full-payload copy while
preserving the wire identity used by Rust and asynchronous browser verification.
Bundle producers register dependencies from the same plan that encoding has just validated,
without immediately decoding the new container again. Contract checks, dependency resolution,
media-source closure and storage budgets still apply. Consumers of received bundles retain the
full container decoder; mutable producer objects are never retained as verification proofs.
`NativeMediaGrants` derives decoder paths exclusively from the main-process authorization lease
or authenticated inline source bytes. Renderer-supplied resource metadata cannot grant local paths.
Materialized media and spool directories are owned by the native job and removed after pending
operations settle; cancellation kills blocked sidecars before waiting for file cleanup.

Audio export prepares one source decoder at a time while retaining the source-bound PCM map for
mixing. This bounds simultaneous codec intermediates and ensures a failed preparation leaves no
other source decode running. Rational audio/video timing and the mixed samples are unchanged.

`WebGpuRenderer.planExportFrame` shares exact-resource discovery with diagnostic frame capture,
but does not reserve an output readback or record the final scene/output graph. Phase A still
prepares media and raster inputs, including temporal text rasters. Only raster pixels are captured;
file-media identities remain in the plan for authorized native decoding. `nativeFramePacket`
rejects file-pixel overrides and owns the plan/resource buffers crossing the native transport.

## Production frames

Output anti-aliasing is captured alongside each Beauty request and render job. Equal project, time,
resolution and AA mode share the same production output path; see [Output Anti-Aliasing](ANTI_ALIASING.md).
Preview resolution changes do not override that captured mode. Legacy requests and jobs use Off.

Aster's production preview and export use one time-addressed beauty-frame request. The request fixes
the beauty buffer, the linear-HDR-to-sRGB display transform, composition effects, and composition
sampling. Preview quality may change only the integer target width and height. It does not disable
effects, select a different color route, or substitute a different sampling policy.

## Shared frame path

`ProductionBeautyFramePipeline` owns the contract boundary:

1. `createBeautyFrameRequest` validates the timeline time and target dimensions and attaches the
   immutable production settings.
2. Production preview presents that request through the renderer's beauty pass.
3. PNG and video export submit the same request to the same beauty renderer. WebGPU copies the final
   post-processed canvas texture into the bounded readback pool after the sRGB display pass.
4. A raw frame is accepted only when it is one tightly packed four-byte pixel per output pixel and
   its pixel format remains stable for the session.

At the same project revision, timeline time, and target resolution, preview presentation and export
therefore evaluate the same composition and final post-processing route. Fake-renderer contract tests
assert byte equality for this case. Resolution-scaled requests share the exact settings object and
differ only in their target dimensions.

Bundled particles use stable source-index draw order for every time-addressed frame. GPU invocation
completion order cannot choose the transparent blending or depth-write order. Culled slots are
overwritten and emit clipped, degenerate vertices, including when seeking backward. The existing
instance quota bounds both storage and the additional visibility checks for offscreen particles.

The final SDR pass applies the IEC sRGB transfer once to straight linear RGB and then restores
premultiplied alpha. Beauty, depth-of-field, and surface diagnostics share that transfer. It preserves
unedited sRGB stills instead of imposing an ACES look; HDR channels clip at the SDR boundary unless
the user adds the Filmic Tone Map effect. Intermediate effect and precomposition surfaces stay linear.
`scripts/gpu-color-check.mjs` imports an RGBA PNG ramp through the real media importer and checks GPU
readback against its original colors, including partial transparency, a neutral effect, in-focus
depth of field, and surface diagnostics. It also verifies the opt-in ACES effect against CPU reference
values. Run `await (await import('/scripts/gpu-color-check.mjs')).run()` in a WebGPU browser
against Vite with `ASTER_BUNDLED_DEV=0`; the allowed error is two 8-bit code values.

The shared text rasterizer produces neutral glyph coverage with the requested fill and stroke.
It does not add a decorative shadow: shadows and glow belong to explicit layer effects. Resetting
Canvas shadow state also prevents a previous draw from contaminating newly rasterized glyphs.

Iris Wipe evaluates its full-open extent using the selected shape's distance metric and center,
including feathering. Completion 0 preserves every pixel and completion 100 removes every pixel;
Invert reverses those endpoints. This prevents diamond corners and off-center irises from remaining
clipped after a transition completes. The calculation stays inside the fused GPU pass. Endpoint
validation executes the actual WGSL case against three shapes, three centers, landscape/portrait
targets, both inversion modes and nine sample locations (648 exact coverage checks).

Foreground PNG-sequence and MP4 jobs capture one runtime structured clone before opening a frame
session. Unlike the persistence sanitizer, this clone retains ephemeral linked-media URLs required by
picture and audio decode. The requested composition is resolved from that clone and made active, so
picture, audio, timing, camera, effects, and media cannot be split across editor revisions while an
export is running. Background manifests likewise derive composition dimensions, rate, and range from
the same persistence-safe document captured before asynchronous serialization yields back to the
editor, with runtime-only media carried separately by the bounded RenderMediaManifest. Electron
copies linked still, video, and audio bytes into a SHA-256-verified job snapshot at enqueue; the
RenderHost never reads the mutable original path. Snapshot roots are correlated with the job and
retained across retry/restart until the queue item is removed.

Background Pause/Continue retains the isolated renderer, encoder processes, media lease, and atomic
output staging under one worker lease. The frame loop gates only between completed frame and PCM chunk
writes; Continue therefore resumes at the next address without rebuilding or duplicating prior output.
Paused time is removed from progress timing, while the retained worker continues to count against the
configured concurrency bound. Cancel, failure, application shutdown, or process restart still cleans
or invalidates the lease; restart does not claim to restore an in-memory encoder checkpoint.

Advanced foreground media is captured before the first asynchronous yield and hydrated under
export-only source IDs. The lease owns immutable SVG markup and PSD document/pixel generations
without replacing the editor registry. Blob/data-URL sequence frames are pinned inline before the
first asynchronous yield. For background jobs, native frames remain lightweight locators until Electron
streams them into the SHA-256 job snapshot. Closing or failing the frame session releases temporary
registry entries even if renderer restoration itself throws.

PNG encoding never reads the canvas independently. It consumes the canonical raw frame used by the
video path. Packed RGBA is copied unchanged; packed BGRA is converted to RGBA exactly once before the
browser PNG encoder. Alpha is preserved in both cases.

## Video timing

Output frames are addressed directly as `frameIndex * denominator / numerator`; no accumulated
floating-point frame clock is used. Compositions containing video advertise `seek-and-await`, limit
the session to one in-flight frame, seek media for the requested time, await the decoded frame, and
then capture the beauty output. Video frames use the same discovery capture as other media: the
first render holds without encoding while any active video lacks its exact frame, and a redraw
follows only after the asynchronous seek completes. A frame whose media is already exact is
rendered once; the renderer never renders the swap-chain texture twice back to back before a
readback, because that sequence can read back black pixels. Exact seeks are biased forward by
0.1 ms so frame-boundary times decode the intended frame. Compositions without video can use up to three ordered WebGPU
readbacks. The Canvas 2D fallback rejects deterministic video export instead of encoding a stale
decoded frame.

The isolated background RenderHost requires WebGPU. Canvas 2D remains an interactive compatibility
backend, but it does not implement the complete production 3D, effect, depth-of-field, motion-blur,
and linear-HDR pass graph. A WebGPU initialization failure therefore fails the queued job with the
actionable `render_host_webgpu_unavailable` code instead of publishing valid-looking fallback pixels.

The native frame-plan decoder consumes the supplied rational or binary-rational video times exactly.
It indexes presentation timestamps from an authorized snapshot, selects the containing interval and
requires the requested and uploaded times to select the same frame. The producer's seek bias is
already encoded in these times. Native decode preserves source color metadata and uses the verified
browser-compatible chroma reconstruction before straight sRGB upload; it rejects unsupported color
routes explicitly. Native snapshot and still decoding bound codec, filter, and raw-output worker
threads to one by default through `DecodeLimits`, avoiding CPU-count-dependent intermediate memory.
This leaves frame selection, color conversion, and output byte limits unchanged.

Exact-frame capture also treats initial image decode, SVG rasterization, image-sequence frame
decode, HDR environment upload, and normal-map GPU validation as frame dependencies. Material
waits have a finite timeout, propagate failures, and abort when the renderer is destroyed;
retired generations cannot delay the active frame even if their source ignores cancellation.
Interactive preview may use fallback material texels while these resources load. A
current-generation resource barrier ignores stale completions,
propagates decode failures and timeouts, and requires a redraw before accepting pixels whenever the
first render discovered pending resources. Cached stills and synchronous text rasterization retain a
single GPU submission; only a newly requested asynchronous generation is prepared and recaptured.

Text animator motion blur is part of that same beauty request. Preview presentation, foreground
readback, and the isolated RenderHost derive identical shutter midpoint times, layer-source time
mapping, adaptive limit, and texture generation identities from the immutable project snapshot.
Time-varying glyph rasters are uploaded and accumulated before the scene pass in the same command
buffer, so the media barrier cannot observe a placeholder generation. Their transient sample and
linear-HDR accumulation textures are released after submission; static text and disabled composition
or layer switches retain the ordinary single-raster/single-submit path.

Advanced 3D depth of field is allocated before GPU texture creation against the auxiliary share of
the configured memory budget. The Base surface-data pass retains its existing MRT cost. K1 adds
16 bytes per output pixel for exact front color plus aggregate transparent depth; K2 adds 36 bytes
per pixel for front/second color, second/aggregate position, and peel depth. Interactive preview may
use K1 (exact front, aggregate deeper transparency) or K0 (canonical beauty at primary depth) and
publishes `depthOfFieldDegradedReason`. Production readback requires K2 and fails with an actionable
allocation error when the budget cannot preserve two independent transparent focal surfaces. A
composition without active depth of field allocates only Base, so normal/ID/motion-vector views and
ordinary Beauty do not pay for layered targets. Resize and tier changes destroy the prior targets
before allocating replacements.

## Session ownership and recovery

Only one renderer-resizing production session or GPU benchmark may own the viewport renderer at a
time. While a session owns it, layout resize, debug-buffer changes, and ordinary preview renders do
not resize or overwrite export targets. Each session bounds concurrent readbacks. Closing during an
in-flight frame defers restoration until the frame settles, then restores the preview dimensions,
buffer selection, project, time, and selection exactly once. The ownership guard releases even when
restoration reports an error, so later sessions can recover.

## Debug buffer views

Linear color, depth, normals, IDs, motion vectors, selection isolation, depth-of-field diagnostics,
and vector-motion-blur views are diagnostic buffer visualizations. They are not production preview
and never change the beauty-frame contract or export output. Selecting one temporarily routes the
interactive viewport through the debug renderer; production preview means the viewport's Beauty
view.

Contract coverage lives in:

- `src/renderer/compositing/beauty-frame.test.ts`
- `src/renderer/gpu/raw-frame-png.test.ts`
- `src/core/rendering/render-session-guard.test.ts`
- `src/core/rendering/render-export.test.ts`
- `src/render-queue/render-job-parity.test.ts`
- `src/render-queue/render-media-manifest.test.ts`
- `electron/render-media-authorization.test.ts`
- `electron/render-media-snapshot-store.test.ts`

Adobe behavior references:

- <https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/modifying-using-views.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/basics-of-rendering-and-exporting/basics-rendering-exporting.html>

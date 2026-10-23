# Production Render Contract

## Production routing

Desktop Beauty preview uses the Rust project evaluator and wgpu renderer through the native preview
broker. Foreground, background, automation and capture exports enqueue immutable jobs through
`NativeQueueHostFactory`; Rust evaluates and renders every output frame. Normal application bundles
exclude the TS WebGPU renderer, its original beauty adapter, browser export entry and hidden RenderHost.
Those modules remain frozen in a separately built reference runtime for comparison.

Canvas 2D remains the unchanged interactive compatibility renderer. It does not qualify production
preview or exports. Missing native export capabilities fail the job explicitly; production never
silently switches to TS GPU rendering. Build-time renderer-boundary checks and packaged application
checks enforce this distinction. Implementation routing alone does not establish final migration
quality or performance acceptance.

## Time-addressed frames

A frame is determined by the immutable project, selected composition, exact timeline address, target
size, output AA and color settings. Output indices evaluate directly as `index * denominator /
numerator`; the clock never accumulates floating-point frame durations. Preview may change target
resolution, but preserves the selected effects, compositing and display transform.

Rust owns scene, property, expression, audio-reactive and recursive composition evaluation. The
expression interpreter preserves the restricted TS operators, functions, time/value bindings and
error fallback, with 2048-character, 512-token and 32-level bounds. It does not execute general JS.
Native text shaping/rasterization uses authenticated font/layout evidence. The isolated retained
raster service provides the explicitly retained SVG/PSD boundary; it supplies authenticated resources,
not host-authored scene plans. Its compatibility text protocol remains available to diagnostic
callers, while admitted production text uses the native route.

GPU surfaces remain linear HDR through compositing and effects. The final SDR pass applies the IEC
sRGB transfer once to straight linear RGB, then restores premultiplied alpha. HDR channels clip at
that boundary unless the project selects Filmic Tone Map. Shared WGSL sources preserve effect and
particle ordering; deterministic source-index order controls transparent particle blending.

Output [anti-aliasing](ANTI_ALIASING.md) is captured with each request/job. Preview size changes never
replace its AA mode. Native renderer capabilities, texture limits and memory budgets govern every
allocation. Unsupported requests fail explicitly instead of silently changing output quality.

## Native preview ownership

The editor sends project updates and exact evaluation times through the main-process broker. Native
preview owns its renderer, source grants and presentation pool. Electron imports completed shared
textures and releases their leases; pooled surfaces cannot be overwritten while a consumer owns them.
A bounded CPU presentation path remains available where the native presentation contract permits it.
Neither transport changes which renderer evaluates the frame.

Revision and generation checks reject stale replies. Pause, snapshot capture, resize, device loss,
producer exit and renderer reload preserve or recreate the appropriate session boundary. Releasing
an editor session releases its private native resources. Snapshot capture cannot resize or overwrite
the visible presentation target. Independent input-to-present measurements qualify interaction
latency; cached-frame throughput cannot substitute for them.

Debug buffer views (depth, normals, IDs, motion, isolation and depth-of-field diagnostics) select
native diagnostic output. They do not change the Beauty request used by queued exports.

## Immutable export jobs

Enqueue captures the selected composition, project snapshot, rational range, resolution, AA and output
modules. Media authorization materializes job-owned, content-addressed copies of linked data. The
worker rechecks document, request and media hashes before each output. Later editor or source-file
changes cannot alter a running result. Installed plugin payloads are frozen and validated under the
existing manifest/WGSL ABI; unavailable plugins preserve the declared disabled/safe-mode behavior.

`aster-render-cli export --project ... --composition ... --out ...` owns project evaluation, media
admission, rendering and encoding. Still PNG, PNG sequence and H.264/AAC MP4 are production outputs.
Outputs of one job execute serially against the same immutable inputs. Publication accepts them as
one transaction only after all modules complete, preserving existing destinations on failure.

Native PNG output reads and encodes RGBA in Rust, preserving alpha and allowing odd dimensions.
The queue requests a streamed image-receipt journal with exact clocks, extents, file hashes and frame
count. Electron validates bounded journal lines and streams publication without retaining a complete
per-frame filename array. Full-frame pixels do not cross renderer IPC. PNG output has no fixed total
disk-byte cap by default; an explicit CLI budget can bound it. Exhausted storage and cancellation
remove private staging rather than publishing a partial sequence.

Native MP4 uses GPU BT.709 limited-range NV12 conversion and a hardware H.264 transform on the
renderer adapter. Shared input is selected only after capability qualification; bounded in-process
NV12 readback is the native alternative with a recorded reason. No software video encoder or TS
renderer is silently selected. Hardware mean/peak VBR settings and the default maximum QP of 18 are
verified through codec property readback. FFmpeg muxes the resulting Annex-B stream into MP4 and
encodes optional 48 kHz stereo audio as AAC. Packet order, rational timing, complete hardware drain,
media identity and successful process close precede atomic publication.

Disabling output audio omits the mixed track while preserving audio inputs for reactive visuals.
Mixing writes bounded chunks and retains source-bound PCM under explicit budgets. Video and image
schedules use constant resident clock storage up to the queue's 10,000,000-frame bound. The current
private video/media limits and optional deadlines are documented in [Render queue](RENDER_QUEUE.md).
They are explicit capability limits, not evidence of unlimited-duration delivery.

## Pause, cancellation and restart

A pause request carries an identity and completes only at a safe native frame, audio or file-operation
boundary. Resume continues under the same worker lease and immutable inputs. Cancel releases a paused
worker, drains or terminates owned processes, removes private staging and releases media authorization
before its scheduler slot becomes reusable. Cancel during pending authorization retains that slot
until the returned authorization lease is released.

Shutdown invalidates interrupted work. Reloading durable queue state permits an explicit retry with
a new worker lease and the original immutable job; it does not restore an encoder checkpoint or append
to a partial MP4. A retry starts a new output transaction. Stale progress or completion from a previous
lease cannot publish into the replacement job.

## Media and resource admission

The main process grants only verified job-owned media paths or authenticated inline content. Native
resource metadata cannot authorize arbitrary local files. Still images, sequences and video retain
exact content and sample identities through decoding and GPU upload. Video timestamps select a
presentation interval from an authenticated snapshot; compatibility clock bias is applied once.
Unsupported codec/color routes fail explicitly. See [Media backends](MEDIA_BACKENDS.md).

Content-addressed GPU resources and raster caches have explicit byte and entry limits. Resident
references reuse immutable verification proofs, but still pass current-frame ownership, closure and
budget checks. Failed admission poisons the affected session and leaves its output unpublished.

## Diagnostic supplied-plan protocol

`aster-render-cli serve` remains available for controlled supplied-plan tests. It accepts versioned
JSON control lines and declared binary payloads with increasing request IDs and bounded framing.
`put_resource`, `evict_resource` and `check_frame` share the native registry; malformed framing closes
the session. Its optional native export protocol exposes `begin_export`, `render_frame`,
`finish_export`, `cancel_export` and warm-up without changing encoded frame clocks.

Historical `NativeRenderClient`, `NativeExportSession`, `NativeFrameAdmission` and compressed-spool
adapters support retained comparisons and diagnostics. Their TS planning, preflight/replay and browser
MP4 IPC are not the production queue path. Frozen reference files remain unchanged.

## Validation

Production checks cover the native project corpus, exact and reviewed pixel comparisons, encoded
video/audio quality, paused/cancelled publication, preview recovery, plugin lifecycle, actual packaged
foreground/background execution and production-bundle retirement. Complete final acceptance requires
all current gates, paired native FPS above retained TS, independent input latency and synchronized
documentation. Development checks do not establish that final result.

Relevant contracts include `electron/native-queue-host.test.ts`,
`electron/native-project-export-process.test.ts`, `electron/native-preview-host.test.ts`,
`electron/native-preview-broker.test.ts`, `electron/render-queue-manager.test.ts`,
`electron/render-media-authorization.test.ts`, and the migration application/lifecycle checks.

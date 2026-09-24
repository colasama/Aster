# Background render queue

Each job captures the application anti-aliasing preference at enqueue. `antiAliasing` accepts `off`,
`fxaa`, `ssaa2x`, or `ssaa4x`; missing legacy values mean `off`. The isolated RenderHost applies this
captured value to every Beauty request. Changing preferences affects subsequent jobs only.

Aster's render queue is a persistent control plane for work that must not depend on the interactive
viewport. Enqueuing captures an immutable serialized project document, a composition and frame range,
and one or more output modules. Later editor changes therefore cannot alter an in-flight result.

The versioned queue model supports queued, preparing, rendering, pause-requested, paused, completed,
failed, and cancelled states. Each worker claim receives a unique lease. Progress, pause, completion,
and failure events with a stale lease are rejected, preventing a replaced or crashed worker from
publishing into a retried job. Progress is monotonic and bounded by the manifest frame range.

The scheduler counts live hidden-host handles in addition to persistent running states. Cancelling a
job changes its visible state immediately, but its slot is not reusable until the correlated host has
drained encoder and IPC work, removed staging data, acknowledged the terminal boundary, and disposed.

Runnable items are ordered by priority, creation time, and stable ID. The scheduler subtracts active
leases from a bounded concurrency limit. Queue snapshots have strict item, output, project-document,
render-media, frame-count, dimension, string, and numeric limits before persistence or worker launch.
Large immutable snapshots are omitted from every editor-facing progress projection.

Within the main process, snapshots copy mutable metadata while sharing immutable capture strings.
Per-frame progress uses the domain's lease, range, and monotonicity validation without reparsing
unchanged project/media JSON. Generic commands and restored documents still receive full validation.
The private persistence path writes this validated state directly. Progress checkpoints run at most
once per 500 ms after the preceding checkpoint finishes: one checkpoint can be in flight and only
the latest waiting revision is retained. Commands, terminal transitions, and shutdown flushes remain
ordered and immediately durable. Slow storage therefore cannot accumulate a full queue per frame or
timer interval, and external snapshot mutation cannot alter pending writes.

The 2026-09-19 reconstruction exposed this cost with nine historical jobs in a 55,878,716-byte queue.
The previous main process exited with a V8 heap exhaustion after reaching about 3.14 GB. An isolated
180-report benchmark of the same queue (no GPU rendering) measured median/P95 progress handling of
157.07/207.76 ms and a 3,318.85 MiB heap peak; draining queued writes took another 21,395 ms. After
the metadata-only progress path and bounded checkpoints, the same burst measured 0.0077/0.0227 ms,
280.45 MiB peak, and a 381 ms final flush. These are queue-control measurements, not video encoding
throughput or foreground preview FPS. A gated slow-storage regression also verifies that several
checkpoint intervals retain only one in-flight write and the newest waiting revision.

Each job pairs the persistence-safe project document with a versioned `RenderMediaManifest` keyed by
source ID and content identity. Embedded still/video/audio data remains in the document. At enqueue,
every linked local source is copied and SHA-256 verified into a content-addressed, job-owned snapshot
under application data. The queued locator is rewritten to that snapshot, so later edits to the
original still, video, or audio file cannot change a frame or sample during a long render. Snapshot
roots are constrained to the job ID and reverified before launch; they survive restart and retry, and
are pruned only after the durable queue item is removed. Asset-protocol grants are transactional and
leased to the correlated hidden host, so a failed authorization publishes no partial grant and worker
cleanup revokes snapshot URLs. SVG stores sanitized markup, one compressed PSD document payload is
shared by all of its layer recipes, and Blob/data-URL image-sequence frames are pinned as bounded
inline resources. Native sequence frames remain locators until Electron streams them once into the same
job-owned snapshot, upgrades persisted FNV/metadata identity to SHA-256, and uses only that digest at
launch. The queue never duplicates decoded PSD RGBA when original document bytes are available.

The Electron job manager claims work with a fresh UUID lease and launches one sandboxed, hidden
`BrowserWindow` per active item. The default scheduler concurrency is one and its bounded host-factory
contract supports increasing that limit without coupling a task to an editor window. The hidden host
uses the same context isolation, navigation denial, sandbox, and permission policy as the editor. A
dedicated minimal preload exposes only logging and sender-authorized RenderHost IPC, through which the
window receives its immutable assignment. Closing or hiding the editor therefore does not interrupt
work already owned by a RenderHost.

The RenderHost parses and validates the captured project, verifies the composition dimensions and
rational frame rate against the manifest, validates every render-media kind and identity, then
hydrates its isolated runtime registry before creating the renderer or submitting frame one. Missing,
changed, unauthorized, oversized, or malformed resources fail the job instead of rendering a
placeholder. It creates the same production beauty-frame request used by the viewport/export path and
reads the same post-processed GPU result. Debug buffer visualization is not a production preview or
background render mode. Video sources use deterministic seek-and-await synchronization; Canvas and
WebGPU both wait for current-generation media before accepting readback pixels.

Graphics exports keep up to three beauty readbacks in flight while the preceding frame is encoded
and written. The shared foreground/background frame pipeline accepts out-of-order readback completion
but writes every output in manifest order. Backpressure bounds residency to three pending frames and
the writer's current raw frame, independently of job length. Raw lookahead also has a 64 MiB budget
(at least one frame): 1080p uses three slots, 4K uses two. Video compositions retain one pending
seek-and-await capture while overlapping that capture with the preceding frame's encoder write.
The renderer serializes asynchronous media preparation until the exact frame has been submitted,
then releases the next capture without waiting for GPU mapping. This prevents an image sequence or
resized SVG from replacing another in-flight frame's media generation.

Frame preparation also reuses Bezier topology across frames (128 entries / 8 MiB estimated CPU
cache) and evaluates shared parent chains once per composition/source time within a flattening call.
Geometry is packed directly into Float32 storage before GPU upload. These optimizations are shared
with the viewport and do not change frame scheduling, image quality, output formats or job manifests.
See [the persistent-data diagnostics](BENCHMARKS.md#persistent-scene-preparation) for methodology,
research sources and measured export results.

Hidden workers never downgrade a queued job to Canvas 2D. Background output requires the WebGPU
production beauty backend and reports `render_host_webgpu_unavailable` when it cannot initialize;
this prevents an incomplete compatibility frame from being atomically published as a successful job.

Pause and cancel controls are correlated by both job and lease and are observed before submission,
after readback, and after all output writes for the current frame finish. Pause stops submissions
and retains the bounded lookahead without writing it; resume consumes those same frames exactly
once. Cancel drains accepted captures and discards unwritten lookahead before acknowledging its
terminal boundary. Pause publishes a durable `paused` state but retains the same
hidden host, GPU renderer, encoders, media authorization, and staged outputs. Continue releases the
frame/audio-chunk gate under that lease, so completed still, sequence, video, and PCM writes are not
repeated. Pause duration is excluded from elapsed time and ETA. A paused worker still consumes one
configured concurrency slot; this bounded resource tradeoff is what makes same-process Continue exact.
Cancel from paused state drains accepted IPC writes and disposes those resources. A renderer crash,
unexpected close, load failure, or stale report cannot complete the item. Application shutdown
disposes paused and running hosts, marks their leases failed, removes temporary data, and flushes the
queue before exit.

PNG stills and PNG sequences are encoded from the canonical raw beauty buffer. H.264 output receives
that same raw RGBA/BGRA buffer and uses the manifest's rational rate and video bitrate. The strict
RenderHost protocol carries the bitrate in integer bits per second and Electron verifies it against
the immutable output module before applying bounded VBR `b:v`, `maxrate`, and `bufsize` controls to
both NVENC and libx264. When an H.264 output enables
audio, the RenderHost decodes each audible source once from the same immutable project snapshot and
mixes stereo Float32 PCM in bounded 48,000-frame chunks. The PCM range begins at the exact rational
manifest start time, while its total sample count is rounded once from the output video-frame count;
FFmpeg therefore receives aligned A/V streams without accumulated frame-time drift. Audio and video
writes run concurrently with awaited IPC backpressure. Pause holds both streams at bounded output
boundaries without closing FFmpeg; cancel, renderer crash, decode failure, or encoder failure disposes
both pipes and removes staged output. If the snapshot has no audible audio/video source, an
audio-enabled module intentionally produces a video-only MP4 rather than manufacturing a silent track.
Before a new encoder starts, its output directory is scanned through a bounded exact-name filter for
`.aster-export` temporaries owned by terminated process IDs. Current-process and unrelated files are
preserved, while an unclean process exit cannot accumulate abandoned frame streams indefinitely.

H.264 output is limited-range BT.709 YUV420. Color parity checks decode the file with FFmpeg into
RGB before comparison with the canonical beauty buffer; readers that ignore the matrix metadata
can introduce a false saturation difference. The export integration test round-trips saturated
color patches from both RGBA and BGRA inputs through a real encoder and metadata-aware decoder.

The RenderHost reports Pause only after the current beauty-frame writes reach their boundary. PCM
observes the same control generation between bounded chunks. Cancel and failure paths first stop and
drain any PCM write already accepted by IPC; only then may Electron dispose the encoder and staged
publisher, preventing late audio writes from racing a closed worker.

Every output is staged beside its destination; existing destinations are backed up and all modules
are renamed into place only after every frame, audio chunk, and encoder completes. Publish failure
rolls back replaced destinations, while failure or cancel removes staging data. The current background
module intentionally rejects H.265 and EXR stills rather than producing a misleading partial result.

`RenderQueueStore` owns the process-wide queue document in the Electron user-data directory. Writes
are serialized, flushed through a temporary file, and atomically renamed while retaining the previous
successful revision as a recovery point. Corrupt primary documents recover from that backup. A queue
created by a newer Aster build is left byte-for-byte untouched. On startup, stale running or paused
worker leases become failed jobs with their last progress retained; retry creates a fresh lease and
restarts from frame zero, so a partial temporary output can never be mistaken for a published render.
Cross-process encoder checkpoint recovery is deliberately outside this same-process Pause/Continue
contract.

The dockable Render Queue panel restores this process-owned document when it mounts and receives
subsequent revisions through a renderer subscription. High-frequency progress revisions are reduced
to at most one React external-store publication per animation frame, so background frames do not
invalidate the editor tree. IPC projections omit immutable project snapshots, and progress
checkpoints are coalesced to a bounded 500 ms cadence while commands and terminal transitions remain
immediately durable. Each job shows its state, monotonic frame progress, elapsed/remaining
time, output target, attempts, and correlated worker error. Command buttons follow the domain state
machine: active leases cannot be removed, pause-requested work cannot receive duplicate controls,
and completed work can reveal its queue-owned destination in the operating-system file browser.

Adding an item captures the current project revision and composition into an immutable snapshot.
Work-area, full-composition, and current-frame ranges are converted with the composition's rational
frame rate. H.264, PNG sequence, and PNG still modules use paths explicitly selected through the
desktop picker. Sequence output is limited to one filesystem-safe child of the selected parent
directory. Queue state and errors remain available after closing, reopening, or rearranging the
panel.

Adobe behavior references:

- <https://helpx.adobe.com/after-effects/desktop/render-and-export/basics-of-rendering-and-exporting/basics-rendering-exporting.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/multi-frame-rendering/multi-frame-rendering.html>

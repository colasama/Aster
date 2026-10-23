# Background render queue

Each job captures the application anti-aliasing preference at enqueue. `antiAliasing` accepts `off`,
`fxaa`, `ssaa2x`, or `ssaa4x`; missing legacy values mean `off`. The native project worker applies this
captured value to every frame. Changing preferences affects subsequent jobs only.

Aster's render queue is a persistent control plane for work that must not depend on the interactive
viewport. Enqueuing captures an immutable serialized project document, a composition and frame range,
and one or more output modules. Later editor changes therefore cannot alter an in-flight result.

The versioned queue model supports queued, preparing, rendering, pause-requested, paused, completed,
failed, and cancelled states. Each worker claim receives a unique lease. Progress, pause, completion,
and failure events with a stale lease are rejected, preventing a replaced or crashed worker from
publishing into a retried job. Progress is monotonic and bounded by the manifest frame range.

The scheduler counts live worker handles in addition to persistent running states. Cancelling a
job changes its visible state immediately, but its slot is not reusable until the correlated host has
drained native process and encoder work, removed staging data, acknowledged the terminal boundary, and disposed.

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

The media manifest codec is independent of browser hydration, so the main process can validate the
same captured data before native project preparation. `NativeQueueAssetStore` provides job-private,
content-addressed copies from explicitly leased local paths or bounded inline payloads. Streaming
hashes retain the existing persisted byte-identity format; copies are rehashed before use, and
duplicate payloads share a verified file. Byte/file budgets, path admission and exclusive writes
prevent the preparation layer from resolving arbitrary locators or overwriting existing data.
`prepareNativeQueueProject` selects the captured composition dependency graph and materializes
still/video/audio, SVG, PSD documents and image sequences through this boundary. PSD pixel-only
captures stay in a bounded, SHA-256-authenticated job-local sidecar, admitted by the retained raster
service without granting additional file access. Trusted installed plugin packages are frozen;
disabled, missing and safe-mode generators are explicitly classified in native export admission.
The authored queue snapshot remains unchanged. The application scheduler uses the native worker.
Preparation retains embedded fonts and material/environment textures and removes folder assignments
only for pruned project items. Captured documents use the queue's 256 MiB input bound; prepared
projects carry explicit native input and sequence admission arguments. The retained raster service
authenticates the full project before projecting its media catalog to SVG/PSD, so native footage and
long image sequences do not pass through the browser's save-file hydration limits.
Historical documents are upgraded by `aster-render-cli normalize-project` using the same Rust
runtime schema migrations as native rendering. The receipt binds both document hashes and the
normalized byte count; publication never overwrites an existing file. Preparation checks dimensions,
rational frame rate and range against the selected immutable composition. Legacy locator-derived
source identities remain distinct from frozen byte identities: an export-private `legacyLocator`
recipe preserves source metadata while native acquisition independently authenticates the copied
bytes and reconstructs the original locator identity. Its text values grant no filesystem access.

The native queue export adapter binds the complete job configuration and rechecks the prepared
project and request hashes before launching each output. It consumes bounded JSON progress and
verifies the project identity, dimensions, clock,
frame count, encoder drain and image receipts before accepting a normal process close. Pause notices
are correlated with the latest request; resume and cancel invalidate stale acknowledgements.
Cancellation keeps the process lease until its pipes close, with bounded forced process-tree cleanup
if cooperative shutdown stalls. Queue-wide scheduling and publication own the surrounding output set.
Export schedules generate frame requests by index with constant resident clock storage, up to the
queue's 10,000,000-frame bound; explicit diagnostic schedules retain their separate smaller limit.
Queue launches bind the mux duration ceiling to the captured frame count and rational rate. Native
exports validate mux requests before starting the frame producer, preserving the original error.
Exports open their immutable catalog without scanning the complete frame schedule. Native evaluation
admits a selected visual source on first use through the same job-local reader and cumulative budgets.
New grants preserve the shared decoded-frame cache and video clocks; they cannot replace existing
grants or reset snapshot byte limits. A failed admission poisons the session and leaves the private
output unpublished. Unused sources outside the requested range are never opened by the decoder.
Explicit diagnostic schedules and preview retain their existing preflight contracts. Complete
long-output delivery and media/output size bounds require separate qualification.
Native queue audio admission allows sources beyond five minutes while retaining a 1 GiB aggregate
decoded PCM budget. The source-duration ceiling is 24 hours; preview keeps its smaller PCM budget.
Export mixing still writes bounded one-second stereo chunks. Temporary WAV files retain their
original RIFF encoding below its size limit and use RF64 size fields above it, with the configured
aggregate staging byte budget enforced before file creation.
Native queue PNG exports stream frame identities into an exclusive private JSONL file. A compact
completion receipt binds its path, hash, byte count and frame count. Electron consumes bounded lines,
validates every frame clock and PNG identity, and retains only the receipt handle while copying.
Publication streams the same authenticated journal again to recheck staged files. It never retains a
per-frame file list or frame set for native outputs. Legacy diagnostic stdout image arrays remain
bounded to 65,536 frames; queue exports always select the streamed protocol.

Native output admission streams completed encoded files into the existing publication transaction.
PNG receipts bind every frame, hash and extent; sequence members retain the queue's captured naming
pattern and absolute frame numbering. All admitted files are rehashed before publication, and a
cancelled copy removes only its incomplete staging file. Mixed PNG/video outputs remain unpublished
until every module is complete. Interrupted rollback preserves original backup files for recovery;
backup deletion after successful publication cannot trigger a destructive second rollback.

`NativeQueueHostFactory` composes immutable input preparation, native output processes and atomic
publication behind the queue host interface. It keeps one report in flight and one latest progress
value, and acknowledges pauses only at native or file-operation boundaries. Each worker owns its
private directory and media authorization until process and staging cleanup finish. Execution settles
before terminal callbacks, allowing the scheduler to dispose a worker from inside its completion
report without a circular wait. Cancellation while authorization is pending retains the scheduler
slot until the returned lease is released. Application startup uses this host by default for interactive
and background automation exports. It resolves application-owned native executables, the raster service
and bridge plugin resolver, and acquires verified media leases. A platform without a native runtime
keeps the editor available but fails queued exports explicitly; no TS GPU fallback is selected.


Each job pairs the persistence-safe project document with a versioned `RenderMediaManifest` keyed by
source ID and content identity. Embedded still/video/audio data remains in the document. At enqueue,
every linked local source is copied and SHA-256 verified into a content-addressed, job-owned snapshot
under application data. The queued locator is rewritten to that snapshot, so later edits to the
original still, video, or audio file cannot change a frame or sample during a long render. Snapshot
roots are constrained to the job ID and reverified before launch; they survive restart and retry, and
are pruned only after the durable queue item is removed. Asset-protocol grants are transactional and
leased to the correlated worker, so a failed authorization publishes no partial grant and worker
cleanup revokes snapshot URLs. SVG stores sanitized markup, one compressed PSD document payload is
shared by all of its layer recipes, and Blob/data-URL image-sequence frames are pinned as bounded
inline resources. Native sequence frames remain locators until Electron streams them once into the same
job-owned snapshot, upgrades persisted FNV/metadata identity to SHA-256, and uses only that digest at
launch. The queue never duplicates decoded PSD RGBA when original document bytes are available.

The Electron job manager claims work with a fresh UUID lease and starts a native project process
for each output module. The default scheduler concurrency is one. Outputs within a job run serially,
while the same immutable project and plugin receipts bind every process. Main-process queue reports
carry the lease identity; renderer windows receive only queue state and control acknowledgements.
The production frontend contains neither the TS GPU renderer nor its hidden RenderHost entry.

Rust evaluates exact rational frame addresses and acquires authorized visual media on demand.
The retained raster service handles explicitly retained SVG/PSD browser rasterization only. Native
PNG output is lossless RGBA; H.264 output uses the native NV12 conversion and BT.709 limited-range
metadata. Encoder completion, image receipt authentication and atomic publication remain separate
boundaries, so a process exit alone cannot establish a completed output.

Pause stops at a safe native frame or bounded audio/file-operation boundary. It retains the active
lease, immutable inputs and private staging; resume continues that job. Cancel stops the process,
waits for cleanup and releases media authorization before another job can reuse the scheduler slot.
Progress is correlated and bounded across all modules, and elapsed-time accounting excludes pauses.

Audio-enabled MP4 outputs use native source decoding and time-addressed mixing. Sources share decoded
PCM by identity under the queue's aggregate budget. Mixing writes bounded one-second Float32 stereo
chunks into a private RIFF/RF64 WAV before AAC muxing; the sample count follows the rational output
frame count. A snapshot without audible sources produces video-only output. Existing destinations
remain untouched until every requested output has been authenticated and staged successfully.

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
The add action acknowledges durable enqueue without waiting for background host preparation.
Media authorization and native-process startup continue under the queue scheduler; launch failures
appear on the queued item. Both add forms show a busy state until capture and persistence finish.
Work-area, full-composition, and current-frame ranges are converted with the composition's rational
frame rate. H.264, PNG sequence, and PNG still modules use paths explicitly selected through the
desktop picker. Sequence output is limited to one filesystem-safe child of the selected parent
directory. Queue state and errors remain available after closing, reopening, or rearranging the
panel.

Adobe behavior references:

- <https://helpx.adobe.com/after-effects/desktop/render-and-export/basics-of-rendering-and-exporting/basics-rendering-exporting.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/multi-frame-rendering/multi-frame-rendering.html>

# Background render queue

Aster's render queue is a persistent control plane for work that must not depend on the interactive
viewport. Enqueuing captures an immutable serialized project document, a composition and frame range,
and one or more output modules. Later editor changes therefore cannot alter an in-flight result.

The versioned queue model supports queued, preparing, rendering, pause-requested, paused, completed,
failed, and cancelled states. Each worker claim receives a unique lease. Progress, pause, completion,
and failure events with a stale lease are rejected, preventing a replaced or crashed worker from
publishing into a retried job. Progress is monotonic and bounded by the manifest frame range.

Runnable items are ordered by priority, creation time, and stable ID. The scheduler subtracts active
leases from a bounded concurrency limit. Queue snapshots have strict item, output, project-document,
frame-count, dimension, string, and numeric limits before persistence or worker launch.

The Electron job manager claims work with a fresh UUID lease and launches one sandboxed, hidden
`BrowserWindow` per active item. The default scheduler concurrency is one and its bounded host-factory
contract supports increasing that limit without coupling a task to an editor window. The hidden host
uses the same context isolation, navigation denial, sandbox, and permission policy as the editor. A
dedicated minimal preload exposes only logging and sender-authorized RenderHost IPC, through which the
window receives its immutable assignment. Closing or hiding the editor therefore does not interrupt
work already owned by a RenderHost.

The RenderHost parses and validates the captured project, verifies the composition dimensions and
rational frame rate against the manifest, and evaluates every frame from its absolute integer index.
It creates the same production beauty-frame request used by the viewport/export path and reads the
same post-processed GPU result. Debug buffer visualization is not a production preview or background
render mode. Video sources use deterministic seek-and-await synchronization; a Canvas fallback
rejects deterministic video instead of silently encoding stale frames.

Pause and cancel controls are correlated by both job and lease and are observed only after all output
writes for the current frame finish. A paused retry or failed task restarts from frame zero under a new
lease. A renderer crash, unexpected close, load failure, or stale report cannot complete the item.
Application shutdown disposes active encoders and hidden hosts, marks their leases failed, removes
temporary data, and flushes the queue before exit.

PNG stills and PNG sequences are encoded from the canonical raw beauty buffer. H.264 output receives
that same raw RGBA/BGRA buffer and uses the manifest's rational rate. When an H.264 output enables
audio, the RenderHost decodes each audible source once from the same immutable project snapshot and
mixes stereo Float32 PCM in bounded 48,000-frame chunks. The PCM range begins at the exact rational
manifest start time, while its total sample count is rounded once from the output video-frame count;
FFmpeg therefore receives aligned A/V streams without accumulated frame-time drift. Audio and video
writes run concurrently with awaited IPC backpressure, and a pause, cancel, renderer crash, decode
failure, or encoder failure disposes both FFmpeg pipes and removes staged output. If the snapshot has
no audible audio/video source, an audio-enabled module intentionally produces a video-only MP4 rather
than manufacturing a silent track.

Every output is staged beside its destination; existing destinations are backed up and all modules
are renamed into place only after every frame, audio chunk, and encoder completes. Publish failure
rolls back replaced destinations, while failure or cancel removes staging data. The current background
module intentionally rejects H.265 and EXR stills rather than producing a misleading partial result.

`RenderQueueStore` owns the process-wide queue document in the Electron user-data directory. Writes
are serialized, flushed through a temporary file, and atomically renamed while retaining the previous
successful revision as a recovery point. Corrupt primary documents recover from that backup. A queue
created by a newer Aster build is left byte-for-byte untouched. On startup, stale worker leases become
failed jobs with their last progress retained; retry creates a fresh lease and restarts from frame zero,
so a partial temporary output can never be mistaken for a published render.

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

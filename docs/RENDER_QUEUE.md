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

The Electron job manager and render host consume this model. They must persist transitions atomically,
launch from the immutable snapshot, write outputs to temporary destinations, and publish atomically
only after every selected output module completes. Interactive preview code must not be the render
host.

`RenderQueueStore` owns the process-wide queue document in the Electron user-data directory. Writes
are serialized, flushed through a temporary file, and atomically renamed while retaining the previous
successful revision as a recovery point. Corrupt primary documents recover from that backup. A queue
created by a newer Aster build is left byte-for-byte untouched. On startup, stale worker leases become
failed jobs with their last progress retained; retry creates a fresh lease and restarts from frame zero,
so a partial temporary output can never be mistaken for a published render.

Adobe behavior references:

- <https://helpx.adobe.com/after-effects/desktop/render-and-export/basics-of-rendering-and-exporting/basics-rendering-exporting.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/automate-rendering/automated-rendering-network-rendering.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/multi-frame-rendering/multi-frame-rendering.html>

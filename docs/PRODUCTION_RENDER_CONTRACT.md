# Production Render Contract

Aster's production preview and export use one time-addressed beauty-frame request. The request fixes
the beauty buffer, the linear-HDR-to-ACES display transform, composition effects, and composition
sampling. Preview quality may change only the integer target width and height. It does not disable
effects, select a different color route, or substitute a different sampling policy.

## Shared frame path

`ProductionBeautyFramePipeline` owns the contract boundary:

1. `createBeautyFrameRequest` validates the timeline time and target dimensions and attaches the
   immutable production settings.
2. Production preview presents that request through the renderer's beauty pass.
3. PNG and video export submit the same request to the same beauty renderer. WebGPU copies the final
   post-processed canvas texture into the bounded readback pool after the ACES display pass.
4. A raw frame is accepted only when it is one tightly packed four-byte pixel per output pixel and
   its pixel format remains stable for the session.

At the same project revision, timeline time, and target resolution, preview presentation and export
therefore evaluate the same composition and final post-processing route. Fake-renderer contract tests
assert byte equality for this case. Resolution-scaled requests share the exact settings object and
differ only in their target dimensions.

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
then capture the beauty output. Compositions without video can use up to three ordered WebGPU
readbacks. The Canvas 2D fallback rejects deterministic video export instead of encoding a stale
decoded frame.

The isolated background RenderHost requires WebGPU. Canvas 2D remains an interactive compatibility
backend, but it does not implement the complete production 3D, effect, depth-of-field, motion-blur,
and linear-HDR pass graph. A WebGPU initialization failure therefore fails the queued job with the
actionable `render_host_webgpu_unavailable` code instead of publishing valid-looking fallback pixels.

Exact-frame capture also treats initial image decode, SVG rasterization, and image-sequence frame
decode as frame dependencies. A current-generation resource barrier ignores stale completions,
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

- `src/renderer/beauty-frame.test.ts`
- `src/renderer/raw-frame-png.test.ts`
- `src/core/render-session-guard.test.ts`
- `src/core/render-export.test.ts`
- `src/render-queue/render-job-parity.test.ts`
- `src/render-queue/render-media-manifest.test.ts`
- `electron/render-media-authorization.test.ts`
- `electron/render-media-snapshot-store.test.ts`

Adobe behavior references:

- <https://helpx.adobe.com/after-effects/desktop/view-and-preview/preview-video-and-audio/modifying-using-views.html>
- <https://helpx.adobe.com/after-effects/desktop/render-and-export/basics-of-rendering-and-exporting/basics-rendering-exporting.html>

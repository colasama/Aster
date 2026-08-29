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

Exact-frame capture also treats initial image decode, SVG rasterization, and image-sequence frame
decode as frame dependencies. A current-generation resource barrier ignores stale completions,
propagates decode failures and timeouts, and requires a redraw before accepting pixels whenever the
first render discovered pending resources. Cached stills and synchronous text rasterization retain a
single GPU submission; only a newly requested asynchronous generation is prepared and recaptured.

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

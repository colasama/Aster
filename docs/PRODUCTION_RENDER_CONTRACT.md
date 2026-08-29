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

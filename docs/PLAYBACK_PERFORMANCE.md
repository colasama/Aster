# Playback presentation

Playback uses the audio clock (or a monotonic fallback) to evaluate each frame at an absolute composition time. Only explicit `setTime` actions advance the seek revision. UI acknowledgements use `setPlaybackTime`, so an expensive React commit cannot be mistaken for a scrub and restart the audio graph.

GPU presentation and the timeline playhead subscribe directly to playback frames. Inspector values and other React consumers receive time at 10 Hz; pausing publishes the exact last presented time immediately. Static previews still render on project, selection, viewport, or time changes. Export sessions retain exclusive ownership of the render target, and imported fonts must be ready before subscribing to presentation.

## Measurement

Use the same project, viewport size, preview quality, app build, and GPU for both runs. Warm imported assets first. Measure at least six seconds of actual playback, recording renderer CPU/GPU time, presentation intervals, wall-clock time, and composition time advancement. A renderer-only benchmark cannot expose React scheduling costs. Do not equate display refresh callbacks or export throughput with actual preview FPS.

An initial Chromium CPU profile on the 73-layer Chinese reconstruction (1280 x 720 composition, development build, RTX 5060 Laptop GPU) reproduced about 16–20 FPS. Renderer CPU time was about 0.6 ms and GPU time about 0.07 ms; React creation, property diffing, and repeated UI work dominated the profile. The six-second run advanced the composition only about 2.6 seconds because stale time was also mistaken for repeated seeks.

An initial post-fix run advanced about 5.9 seconds in six wall-clock seconds. Its final UI metric was about 55 FPS; that single sample is not a sustained display-frame measurement.

A later production-renderer measurement used the completed 314-layer reconstruction, a 1280 x 720 GPU target, warm imported assets, and the same RTX 5060 Laptop GPU. The harness counted `GPUQueue.submit` calls and `aster:playback-frame` events over three six-second intervals, then paused and allowed the UI to acknowledge the final frame. Renderer-backgrounding and occlusion throttling were disabled in this measurement harness. Those flags are not application defaults.

| Composition start | GPU submission rate | 95th-percentile submission interval | Last frame / paused time |
| --- | --- | --- | --- |
| 1 s | 94.8 Hz | 35.3 ms | 6.932 / 6.932 s |
| 7 s | 55.2 Hz | 39.6 ms | 12.980 / 12.980 s |
| 13 s | 75.7 Hz | 38.1 ms | 18.999 / 18.999 s |

Submission counts include two static updates per interval and do not prove scanout or unique displayed frames. The useful findings are that composition time now follows elapsed playback time, pausing retains the last presented time, and presentation continues independently of React acknowledgements. These workload-specific observations are not a guaranteed frame-rate floor; cold text/asset rasterization and expensive effects still require separate profiling.

The playback hook regression tests exercise delayed UI acknowledgements, explicit seeks, exact pause time, work-area looping, cancellation, and per-frame presentation with bounded UI updates.

Portable media hydration creates owned Blob URLs. The renderer's `connect-src` policy permits `blob:` so audio decoding and export snapshot capture can read those same bytes; allowing Blob media elements alone is insufficient for `fetch`.

Effect parameters declared in pixels retain composition-space units in the project. Fused layer and adjustment programs scale evaluated pixel parameters and mask feathering by the render-target scale before uploading uniforms. Normalized centers, angles, colors, and percentages remain unchanged. This keeps reduced-resolution previews consistent with full-resolution exports without resizing CPU image buffers or altering keyframes.

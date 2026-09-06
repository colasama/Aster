# Playback presentation

Playback uses the audio clock (or a monotonic fallback) to evaluate each frame at an absolute composition time. Only explicit `setTime` actions advance the seek revision. UI acknowledgements use `setPlaybackTime`, so an expensive React commit cannot be mistaken for a scrub and restart the audio graph.

GPU presentation and the timeline playhead subscribe directly to playback frames. Inspector values and other React consumers receive time at 10 Hz; pausing publishes the exact last presented time immediately. Static previews still render on project, selection, viewport, or time changes. Export sessions retain exclusive ownership of the render target, and imported fonts must be ready before subscribing to presentation.

## Measurement

Use the same project, viewport size, preview quality, app build, and GPU for both runs. Warm imported assets first. Measure at least six seconds of actual playback, recording renderer CPU/GPU time, presentation intervals, wall-clock time, and composition time advancement. A renderer-only benchmark cannot expose React scheduling costs. Do not equate display refresh callbacks or export throughput with actual preview FPS.

An initial Chromium CPU profile on the 73-layer Chinese reconstruction (1280 x 720 composition, development build, RTX 5060 Laptop GPU) reproduced about 16–20 FPS. Renderer CPU time was about 0.6 ms and GPU time about 0.07 ms; React creation, property diffing, and repeated UI work dominated the profile. The six-second run advanced the composition only about 2.6 seconds because stale time was also mistaken for repeated seeks.

With explicit seek revisions and presentation independent of React commits, the same six-second run advanced about 5.9 seconds (the UI read preceded the final pause commit) and the final preview metric was about 55 FPS. React work is bounded and the profile contains substantially more idle time. These are workload-specific observations, not a guaranteed frame-rate floor; cold text/asset rasterization and individual expensive effects still require separate profiling.

The playback hook regression tests exercise delayed UI acknowledgements, explicit seeks, exact pause time, work-area looping, cancellation, and per-frame presentation with bounded UI updates.

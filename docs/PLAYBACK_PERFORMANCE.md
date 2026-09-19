# Playback presentation

Playback uses the audio clock (or a monotonic fallback) to evaluate each frame at an absolute composition time. Only explicit `setTime` actions advance the seek revision. UI acknowledgements use `setPlaybackTime`, so an expensive React commit cannot be mistaken for a scrub and restart the audio graph.

The application owns the playback hook. Timeline and graph panels subscribe to presentation without
creating additional playback loops; closing or rearranging panels does not stop the audio clock.

GPU presentation and the timeline playhead subscribe directly to playback frames. Inspector values and other React consumers receive time at 10 Hz; pausing publishes the exact last presented time immediately. Static previews still render on project, selection, preview quality, or time changes. Viewer zoom and layout changes retain the existing composition-sized preview target. Export sessions retain exclusive ownership of the render target, and imported fonts must be ready before subscribing to presentation.

Stationary timeline rows consume a memoized document/selection context rather than the clock and
profiler context. A memoized row list also isolates them from parent transport renders. Expanded
property values still consume sampled time. Pointer handlers read the latest action references and
resolve the current snap targets once at pointer-down, so avoiding marker renders does not leave a
stale playhead in a subsequent drag. Project edits, selection, zoom and gesture previews still
invalidate the row list normally.

Frame-rate smoothing includes intervals longer than 100 ms during continuous playback. Only idle
gaps (including entering playback after an idle preview) use the nominal initial interval; replacing
a real playback stall with 16.67 ms would incorrectly report approximately 60 FPS.

## Measurement

Multi-stop gradients compile into one existing 16-float fused-pixel operation. Five RGB colors
remain exact as packed 24-bit integers in f32 uniforms; the shader performs four bounded segment
checks with no additional texture sampling. Animated stops update uniforms at the requested time
and retain the input alpha. Static card instances can continue sharing a single rasterized vector
source, while flowing masked ribbons use the gradient without rerasterizing their color field.

SVG raster viewports retain the untransformed layer aspect ratio. Raster density uses the larger
absolute transform scale, leaving nonuniform stretch and reflection to geometry. Resizing the SVG
viewport independently on each axis would let `preserveAspectRatio` cancel the intended stretch.
The GPU path keeps its existing bounded scale buckets; changing only the smaller transform axis
reuses the same raster and upload. Canvas fallback uses the same viewport calculation.
Text raster density includes evaluated parent scale in both the main renderer and isolated
precompositions. Existing 1.25x density buckets and the 8x/texture-dimension caps limit generation
churn and memory while keeping enlarged letterforms sharp; temporal text uses the same density.

Use the same project, viewport size, preview quality, app build, and GPU for both runs. Warm imported assets first. Measure at least six seconds of actual playback, recording renderer CPU/GPU time, presentation intervals, wall-clock time, and composition time advancement. A renderer-only benchmark cannot expose React scheduling costs. Do not equate display refresh callbacks or export throughput with actual preview FPS.

Also count distinct source-frame addresses reached by playback events over the measured source
span. Bursts of fast submissions separated by long React commits can have a high mean submission
rate while skipping many 30 FPS source frames. Record coverage and tail intervals alongside the
mean; this still measures submitted work, not physical display scanout. Capture development and
production builds separately because React development diagnostics can amplify repeated prop
diffing, especially large keyframe snap-target arrays.

An initial Chromium CPU profile on the 73-layer Chinese reconstruction (1280 x 720 composition, development build, RTX 5060 Laptop GPU) reproduced about 16–20 FPS. Renderer CPU time was about 0.6 ms and GPU time about 0.07 ms; React creation, property diffing, and repeated UI work dominated the profile. The six-second run advanced the composition only about 2.6 seconds because stale time was also mistaken for repeated seeks.

An initial post-fix run advanced about 5.9 seconds in six wall-clock seconds. Its final UI metric was about 55 FPS; that single sample is not a sustained display-frame measurement.

A later production-renderer measurement used the completed 314-layer reconstruction, a 1280 x 720 GPU target, warm imported assets, and the same RTX 5060 Laptop GPU. The harness counted `GPUQueue.submit` calls and `aster:playback-frame` events over three six-second intervals, then paused and allowed the UI to acknowledge the final frame. Renderer-backgrounding and occlusion throttling were disabled in this measurement harness. Those flags are not application defaults.

| Composition start | GPU submission rate | 95th-percentile submission interval | Last frame / paused time |
| --- | --- | --- | --- |
| 1 s | 94.8 Hz | 35.3 ms | 6.932 / 6.932 s |
| 7 s | 55.2 Hz | 39.6 ms | 12.980 / 12.980 s |
| 13 s | 75.7 Hz | 38.1 ms | 18.999 / 18.999 s |

Submission counts include two static updates per interval and do not prove scanout or unique displayed frames. The useful findings are that composition time now follows elapsed playback time, pausing retains the last presented time, and presentation continues independently of React acknowledgements. These workload-specific observations are not a guaranteed frame-rate floor; cold text/asset rasterization and expensive effects still require separate profiling.

## Enchanted Love semantic composition workload

The 2026-09-19 production preview run uses the 130.1-second native reconstruction from
`examples/projects/enchanted-love`: 93 compositions, 873 authored layers, 48 scene cuts, reusable
joint rigs and props, and five grid cloners. Its only imported media is the stereo soundtrack.
The visible Electron window renders at 1280 × 848, quality 1, with FXAA. No export runs concurrently.
The machine uses a Ryzen 9 8945HX and GeForce RTX 5060 Laptop GPU (driver 32.0.15.9621);
WebGPU reports the high-performance Blackwell adapter with timestamp queries enabled.

The harness observes playback-frame events and GPU queue submissions throughout the composition.
Each submission is associated with the most recent playback-frame address. This measures renderer
delivery to the GPU, not physical display scanout. Every one of the 3,903 source addresses has a
submission in this run. Each complete ten-second interval contains all 300 expected addresses.

| Measurement | Result |
| --- | ---: |
| Renderer CPU P95 | 2.5 ms |
| GPU P95 | 0.459 ms |
| Submission interval P95 | 6.8 ms |
| Longest submission interval | 36.6 ms |
| Estimated VRAM peak | 78.1 MB |
| Source addresses with a GPU submission | 3,903 / 3,903 |

The isolated 36.6 ms interval exceeds a 30 fps frame period; this run does not establish a hard
real-time deadline guarantee. It does show continuous source-time advancement and complete source
frame coverage, including all scene transitions. Group effects reuse GPU surfaces with existing
depth/count/memory budgets. Primitive repetition uses native cloners, and mirrored rigs require no
per-frame path rebuilding. Machine-readable measurements are stored with the local delivery.

The playback hook regression tests exercise delayed UI acknowledgements, explicit seeks, exact pause time, work-area looping, cancellation, and per-frame presentation with bounded UI updates.

A timeline-isolation regression measurement used the 456-layer Chinese project in a production
renderer, a 1920 x 1080 GPU target at full preview quality, warmed assets, and a visible, focused
window. No background-throttling overrides were used. Each sample played for six seconds.

| Composition start | Source-frame coverage before / after | P95 submission interval before / after |
| --- | --- | --- |
| 0 s | 76.7% / 100% | 53.1 / 12.5 ms |
| 24 s | 76.8% / 100% | 53.6 / 11.9 ms |
| 48 s | 74.6% / 100% | 52.3 / 17.7 ms |
| 67.2 s | 78.3% / 100% | 53.7 / 17.8 ms |

Coverage counts distinct `floor(playbackTime * 30)` addresses over the sampled source span.
The organized original-language project also reached 100% coverage at the same four start points
after this change. Every pause retained the last playback-event time. These samples verify source
frame scheduling rather than physical scanout, and do not establish a sustained display FPS.
The timeline regression test separately verifies skipped row renders during clock/profiler updates,
fresh playhead snapping, selection feedback, and document edits.

Portable media hydration creates owned Blob URLs. The renderer's `connect-src` policy permits `blob:` so audio decoding and export snapshot capture can read those same bytes; allowing Blob media elements alone is insufficient for `fetch`.

Effect parameters declared in pixels retain composition-space units in the project. Fused layer and adjustment programs scale evaluated pixel parameters and mask feathering by the render-target scale before uploading uniforms. Normalized centers, angles, colors, and percentages remain unchanged. This keeps reduced-resolution previews consistent with full-resolution exports without resizing CPU image buffers or altering keyframes.

Adjacent 3D layers share depth testing. A subsequent 2D layer separates that depth group and composites in layer-stack order; otherwise foreground 3D pixels can reject a later title or letterbox matte. Root and isolated precomposition passes retain color and lazily clear depth at this boundary. The clear reuses the existing depth attachment and is folded into the next direct draw pass, including when adjustment effects intervene.

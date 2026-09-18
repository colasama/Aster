# Output Anti-Aliasing

Preferences exposes Off, FXAA, SSAA 2× (4 samples), and SSAA 4× (16 samples). The setting is
application-wide, persisted in preferences schema v3, and applied to both production Beauty preview
and output. New profiles and profiles without an AA preference default to FXAA; explicitly saved
choices are preserved. Legacy queued jobs still default to Off. Debug buffers retain their native
single-sample values. Canvas 2D rejects enabled production AA modes.

FXAA renders at the requested output resolution, then applies a bounded directional edge filter to
the display-referred image. It uses luminance and alpha contrast, skips low-contrast pixels, and
filters premultiplied RGBA together. It can soften fine text and does not reconstruct missing
subpixel geometry or eliminate temporal shimmer.

SSAA multiplies each internal scene dimension by two or four. Geometry, layer effects, text/SVG
resolution requests, depth buffers, motion blur, and precomposition surfaces use the increased
sampling density. Existing composition-space effect parameter scaling remains in effect. The final
pass averages the corresponding 2×2 or 4×4 display-referred premultiplied pixels. This is spatial
supersampling of the completed display image, not a linear-HDR resolve before tone mapping. Neither
SSAA nor FXAA introduces history, time jitter, or a dependency on the previous frame.

The ordinary post-process and depth-of-field output branches both write to the same reusable AA
input target. AA then writes to the original-size canvas before the existing packed frame readback.
PNG and video dimensions do not change. Off bypasses the extra pass and owns no AA target. Pipelines
are cached per selected mode; resize and disable destroy the previous target. GPU post-process
timestamps include AA, and frame draw/pass counts and memory estimates include its resources.

Beauty requests carry the selected mode. Foreground sessions capture it when opened; background
manifests capture it at enqueue, so preference changes do not alter an existing job. This field is
validated at the queue boundary and survives retry/restart. It is not embedded in the project file.
Transitioning from preview to readback settles pending presentation work once, while subsequent
export frames retain the bounded concurrent readback path. In-flight readbacks prevent target changes.

Target planning checks GPU dimensions and a minimum memory footprint before allocating AA targets.
The scene memory estimate also includes the AA texture. SSAA precomposition targets that cannot
retain the requested density fail explicitly instead of silently downscaling. Existing text/media
raster limits still apply. Select a lower AA mode or output resolution when a target exceeds limits.
Allocation estimates cover known resources, not guaranteed physical GPU availability.

## Validation

Unit coverage checks preferences migration, UI save/restore, immutable queue capture, Beauty target
configuration, target sizing, resource reuse, and disable cleanup. Run frontend and Rust checks with
`pnpm exec lefthook run pre-push`.

For real GPU pixel checks, start the unbundled Vite server (`ASTER_BUNDLED_DEV=0`) and run
`await (await import('/scripts/gpu-anti-aliasing-check.mjs')).run()` in a WebGPU browser on that origin.
The check measures partially covered edge pixels, checks premultiplied alpha, exercises every mode
through the production renderer, verifies stable repeated output, restores Off, and tests odd sizes.

For performance comparison use identical project revisions, times and output sizes; warm each mode
before measuring GPU post time, total GPU time and estimated VRAM at 1080p and 4K. Record adapter,
mode, output dimensions and resource failures. SSAA 2× and 4× require four and sixteen times as many
internal pixels; frame-time ratios depend on geometry, effects, cache use and memory bandwidth.

Algorithm background: [NVIDIA FXAA whitepaper](https://developer.download.nvidia.com/assets/gamedev/files/sdk/11/FXAA_WhitePaper.pdf).

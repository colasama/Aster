# Nested compositions

Composition references can be dragged from the Project panel onto a timeline, or inserted with
the composition context menu. Each reference owns its span, transform, effects, audio controls and
source-time mapping. Double-clicking its timeline name opens the source. References do not copy
source layers or media bytes. Direct and indirect cycles are rejected before editing the project.

## Compositing contract

Normal references render the source with its own camera, lighting, normal maps, HDR environment,
adjustment stack and child effects into premultiplied linear `rgba16float`. A transparent clear is
independent of the composition's viewer background. New blank compositions contain no background
layer; an explicit solid or shape background remains ordinary visible content. Wrapper effects run
on the source surface, followed by the wrapper transform, opacity and blend in the parent. Thus two
overlapping opaque children under a 50% wrapper produce 50% group alpha, not 75% alpha.

Enabling **Collapse transformations** composes child matrices into the parent scene and uses the
parent camera. Child cameras do not enter the parent camera selection. Matrix multiplication retains
nonuniform scale, shear and 3D rotation; interpolated textures retain homogeneous clip W. Child lights
join the parent lighting scope. Wrapper effects, non-normal wrapper blending and source adjustments
establish an isolation boundary. A collapsed boundary first evaluates transformed children using
the parent camera into a parent-sized target, then applies its group operations.

Source clocks are evaluated by time address for every reference. Time offset, stretch and time-remap
are independent across instances. Samples outside `[0, source.duration)` are transparent and silent.
Precomposing a selection preserves its existing timeline coordinates and pre-roll keyframes.

Audio follows references independently of visual visibility. Ancestor mute/enable, gain, pan and
source-time mapping compose along each instance path. Playback of nested/remapped audio and export
use the same sample mixer; playback schedules a bounded rolling window rather than mixing a whole
project before starting. Simple unnested audio retains its native Web Audio scheduling path.

## Transparency and performance

Consecutive 3D geometry layers share a per-pixel depth group. This includes sampled precomposition
planes, shapes, images, text and meshes. Transparent planes can intersect: fragments are collected
and sorted at each pixel, so one plane can be in front on one side and behind on the other. Equal
depths between layers use stable stack order. 2D layers, effects, adjustments and scene-generator
stack entries remain group boundaries. Plugin-generated particles are not folded into this geometry
fragment-list protocol.

The renderer uses tiled GPU fragment lists, not object-centroid sorting or weighted transparency.
It reuses the material fragment shader during capture and applies each layer's blend mode during
resolution. Tiles adapt to primitive count, up to 512 pixels per side, targeting about 32 MiB of
fragment storage. Tile and draw uniforms occupy separate dynamic records, so their memory grows
with tiles plus draws instead of tiles multiplied by draws. Ordinary opaque geometry and single six-vertex planes retain the direct path.
Pixel data remains GPU-resident. A four-byte asynchronous overflow flag is the only transparency
readback; production capture waits for it. The 128-fragment per-pixel limit produces an explicit
failure instead of silently using an approximate image.

Sources are prepared in dependency order. Identical source/time requests share one target in the
frame; instance effects and collapsed camera contexts separate their keys. Across frames, compatible
targets and vertex buffers are reused, and stale targets are evicted. Child materials load only
when needed and production capture waits for their exact resource generation. Intermediate surfaces
do not perform a display transform. Export uses an owned texture so browser swapchain alpha cannot
replace transparent pixels with opaque black.

Targets retain source resolution. Exceeding device dimensions, recursion bounds or the surface VRAM
budget is an error; the renderer does not silently downscale or omit a child. The current safety
bounds are 64 nested surfaces along a path, 1,024 distinct surfaces, and a 512 MiB hard surface budget
(the configured budget can impose a lower limit). This is a bounded resource cache, not a full
dependency-lifetime aliasing allocator. Render metrics include transparency passes, draws and storage.

## Compatibility boundaries

This implements Aster's composition reference and depth-sharing semantics, not complete After
Effects project compatibility. Track mattes, masks and Advanced 3D features are separate systems.
Scene generators retain their existing ABI and compositing boundaries. Source text motion blur retains its time-sampled raster path. Normal sources reuse the root
vector motion-blur and camera depth-of-field passes in scene-linear space before wrapper effects.
Their existing reconstruction and layered-depth limitations remain the same in nested and root
compositions. Collapsed sources use parent camera post-processing. Canvas fallback reports that nested/3D
rendering requires WebGPU instead of displaying a placeholder rectangle.

## Verification

Run the real-device test from the repository root:

```powershell
pnpm exec electron scripts/gpu-nested-compositions-run.cjs
```

The runner starts an isolated local Vite server and hidden Electron window, checks raw exported
pixels, prints results and closes both. It verifies transparent backgrounds, premultiplied color, group alpha, wrapper effects/blending,
intersecting translucent planes, draw-order independence, collapsed parent depth, ordinary
isolation, six independent source clocks, negative source time, material/light parity, nested depth of field, nested motion blur and explicit
overflow. The final benchmark renders two large intersecting translucent planes at 1920 × 1080,
discards two warm-up frames and measures ten frames including GPU completion, without pixel readback.
These timings describe that workload and adapter, not arbitrary project performance.

On the development machine's high-performance WebGPU adapter, the initial run measured a 3.9 ms
median and 4.6 ms maximum for those ten frames. Re-run locally for meaningful hardware comparisons.
Unit tests separately cover migration, cycle rejection, source timing, nested audio, matrix/shear
composition, resource planning and ownership.

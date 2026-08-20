# GPU scaling strategy

This document fixes the implementation boundaries for compositions that exceed a device's practical
working-set or binding limits. It is a design contract, not a claim that tiled rendering or bindless
resources are already active.

## Huge-composition tiles

Tiling is an export and cache strategy. Interactive preview continues to render a downscaled full
frame because it gives predictable latency and avoids visible seams while editing.

The render graph compiler records a pixel footprint for every node. Point operations have a zero
footprint; convolution, shadow, blur, and displacement nodes declare a bounded radius; global
histograms, optical flow, unbounded particles, and unknown plugins are non-tileable. A tile request
contains the full-frame dimensions, an interior rectangle, the accumulated halo, frame time, color
space, and deterministic seed. Coordinates and procedural noise always remain in full-frame space.

The scheduler chooses a power-of-two interior between 256 and 1024 pixels from the transient-memory
budget. It expands each tile by the graph's accumulated halo, clamps source reads at composition
edges, renders into pooled textures, and copies only the interior into the destination. Premultiplied
linear compositing and one final output transform are mandatory; applying tone mapping per tile would
produce discontinuities. Tiles are submitted in stable scan order for reproducibility but may execute
in parallel command buffers when their graph has no temporal dependency.

A graph falls back to full-frame rendering when any node is non-tileable or its halo consumes more
than half the selected tile. If the full frame also exceeds the budget, export fails before allocation
with the offending node and required bytes. Temporal nodes checkpoint full-frame state at bounded
intervals; tiles never advance separate simulation clocks. Cache keys include graph hash, frame,
interior, halo, quality, color configuration, and device-independent shader version.

The first implementation must ship seam tests for odd dimensions, alpha edges, chained blur halos,
3D camera coordinates, and tiles rendered in a shuffled execution order. A huge-composition benchmark
reports peak transient bytes, tile reuse, encoded pixels, and CPU/GPU overlap without wall-clock pass
thresholds on shared CI hosts.

## Resource arrays and bindless access

WebGPU feature availability is the contract boundary. At device creation Aster records support and
limits for texture binding arrays, sampler binding arrays, non-uniform indexing, and per-stage sampled
resources. A renderer may select the resource-array path only when every required feature is present;
project files and plugin manifests never encode that choice.

The preferred path uses immutable-size arrays grouped by texture class (linear color, sRGB decode,
data, depth) and sampler class. A generational 32-bit handle contains a slot and generation; shaders
receive handles through instance/storage data and reject stale generations to a transparent fallback.
Slots are assigned by a frame-stable allocator, retired only after submitted work completes, and
bounded by both adapter limits and Aster's memory budget. Plugin graphs receive host-assigned handles
only for declared resources and cannot index the host's global table.

The portable fallback remains sorted draw batches with conventional bind groups. Texture atlases are
allowed only for clamp-safe 2D imagery with compatible formats and mip policy; video, repeat sampling,
depth, and externally owned textures stay separate. Both paths consume the same logical resource
table, so capability fallback changes performance rather than pixels or project semantics.

The prototype gate requires identical reference output across array and batched paths, churn tests for
slot reuse and device loss, quota tests at adapter limits, and traces proving that large clone groups
share media resources instead of allocating one texture per instance.

# SVG import

Aster preserves sanitized SVG markup and its viewBox as the source of truth. Active elements, event
attributes, external references, CSS imports, and external URL functions are rejected before the
source enters a project.

SVG footage is rasterized from vector markup at the exact physical pixel dimensions required by the
current preview or export. Preview resolution and device pixel ratio affect only the raster target;
the viewBox and composition-space geometry do not change. Oversized requests are uniformly reduced
to device texture and pixel budgets, preserving aspect ratio.

Raster results use an identity-and-size keyed LRU. Concurrent requests share work, source reloads
receive a new identity, and old ImageBitmap/GPU resources are closed through the cache disposer.
This avoids blurry intrinsic-size upscaling and prevents interactive zooming from growing memory
without limit.

Adobe behavior reference:

- <https://helpx.adobe.com/after-effects/using/preparing-importing-still-images.html>

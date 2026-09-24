# Media Import Pipeline

Aster imports advanced still media through one bounded, time-addressable pipeline. The Project
panel exposes SVG, PSD, and image-sequence controls alongside ordinary image, video, and audio
sources.

## Import behavior

- SVG input is parsed as XML, rejects scripts, event handlers, external references, and unsafe CSS,
  and keeps sanitized vector markup in the import runtime. The renderer rasterizes it for the
  physical display target and caches geometric size buckets so animated scale changes do not force
  a raster on every frame.
- PSD supports **Footage / Merged**, **Composition**, and **Composition · Retain Layer Sizes**.
  Composition imports create a transparent composition plus one source and image layer per
  drawable PSD layer. Visibility, opacity, supported blend modes, bounds, and layer placement are
  retained. Folder divider records and empty pixel planes are skipped with a visible warning.
- Image sequences are detected from the selected numbered frame. Native discovery scans only its
  immediate directory and returns files matching the same prefix, padding, and extension. Browser
  fallback accepts a multi-file selection. Frame rate is stored as an exact numerator/denominator,
  and missing frames use the selected error, hold-previous, or nearest-frame policy.

## Runtime and performance

Heavy import state never enters project operations or undo snapshots. PSD pixel planes, browser
`File` handles, sequence frame URLs, and sanitized SVG parse state live in the media import runtime
registry and are referenced by source ID.

The WebGPU path uploads PSD crop rows directly from the decoded plane without padding the complete
document or producing PNG/base64 intermediates. Sequence frames use a bounded LRU decode cache,
deduplicate concurrent work, and preload neighboring frames with bounded concurrency. SVG rasters
use a separate bounded LRU. A ready texture remains bound until its replacement has decoded and
uploaded, preventing playback flashes during frame changes.

Canvas 2D fallback consumes the same source timing and policies. PSD crops use `putImageData` dirty
rectangles over the original decoded buffer, and SVG uses object URLs that are revoked when the
resource leaves the active scene.

## Native path security

The desktop picker grants only explicitly selected files. Image-sequence discovery is permitted
only for a granted seed, is bounded to 100,000 directory entries, filters supported image formats,
and authorizes only the matching sibling frames for the read-only `aster-asset` protocol. Raw file
paths and decoded payloads are never encoded into data URLs.

## Diagnostics

Importer failures include the parser or validation diagnostic in the Project panel. Runtime decode
errors are tracked per source and shown on its project row. Import warnings are surfaced as a count
without blocking successfully decoded layers. Layers whose footage cannot be resolved — no data or
runtime locator, or a failed decode — draw a solid magenta placeholder in the layer bounds instead
of silently compositing a blank quad.

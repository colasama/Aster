# Aster project format v10

## Light layers

Existing `light` layer records require no migration for multiple-light rendering. Up to eight
visible, time-active lights contribute in flattened scene order. The first light controls the
shadow map; additional directional, point and spot lights contribute unshadowed illumination.
Their existing color, transform, intensity, range and cone settings remain editable and undoable.

## Project fonts

The optional root `fonts` array stores project-owned faces as `{id, name, family, weight, dataUrl}`.
Variable faces may additionally store `weightRange: [minimum, maximum]` (inclusive integer CSS
weights from 100 to 900, containing `weight`). Same-family ranges must not overlap. The runtime
registers that range with FontFace so selection uses the real weight axis rather than synthetic
bold. TTF/OTF imports detect the SFNT `fvar` weight axis without decoding glyphs; compressed
WOFF/WOFF2 imports can supply the range explicitly through MCP `import_font`. Existing fixed
faces retain their original behavior. Range changes invalidate the bounded decoded-face cache.
`family` is the CSS family alias, `weight` is an integer from 100 through 900, and `dataUrl` is embedded
base64 TTF, OTF, WOFF or WOFF2 (`data:font/<format>;base64,...`). IDs and family/weight pairs must be
unique. There are at most 32 faces and 8 MiB of decoded font bytes in one project. Missing `fonts`
means no embedded fonts, so existing v10 documents remain compatible without migration.
Saving, recovery, packing and render snapshots retain these bytes; font paths and runtime `FontFace`
objects are never persisted. The browser must successfully decode fonts before opening a document,
importing a face or producing output. Imports never modify the operating system font collection.
Font collections and variable-axis metadata are not imported; provide an individual supported face.

Text layers persist `textStyle.fontFamily`, `fontSize`, `fontWeight`, alignment, tracking, leading and
stroke settings. Font removal retains the requested family so Chromium can fall back. Removing an
embedded face or switching projects invalidates text textures, including temporal text rasters.

The development editor currently exchanges a readable JSON document named `*.aster.json`. The Rust
bundle layer stores the same versioned domain model inside an atomically replaced project path. Cache,
proxy, and preview data are deliberately excluded.

## Required root fields

```json
{
  "schemaVersion": 10,
  "id": "stable-uuid",
  "name": "Project name",
  "activeCompositionId": "stable-uuid",
  "compositions": [],
  "sources": [],
  "folders": [],
  "itemFolderIds": {},
  "commandLog": [],
  "updatedAt": "2026-08-20T00:00:00.000Z"
}
```

A composition declares dimensions, rational frame rate, duration, linear RGBA background, an
optional HDR environment, and an ordered layer list. The environment stores an enable flag, bounded
linear intensity, equirectangular rotation, and an embedded Radiance RGBE source. Readers accept only
`image/vnd.radiance` or `image/x-hdr`, cap the encoded source at 64 MiB, and the renderer further caps
decoded maps at 8192 × 4096 and 16 million pixels.

Version 7 persists motion blur as two independent switches. A composition has required
`motionBlur` settings containing `enabled`, a 0–720 degree `shutterAngle`, a -720–720 degree
`shutterPhase`, 2–64 base samples, and a 2–128 adaptive sample limit that may not be below the base.
Every layer has its own required `motionBlur` boolean. Both switches must be true before the renderer
evaluates shutter endpoints. The default 180 degree angle and -90 degree phase center the exposure on
the current frame.

Version 8 replaces the legacy single staggered text reveal with ordered animator groups. Each group
has a stable ID and name, a bounded property stack, and zero or more ordered Range, Wiggly, or
Expression selectors with their own stable IDs and editable names. Numeric selector controls and animator properties use the same static/keyframe
track representation as layer transforms, so evaluation is seekable and deterministic. A group with
no selectors affects every grapheme. Expression source is bounded and evaluated by a numeric AST
host; arbitrary JavaScript is never stored as executable renderer code. Line Anchor is a scalar
0–100% tracking alignment, and Character Offset/Value require an explicit Preserve Case & Digits or
Full Unicode Character Range.

Layer blend modes include normal, add, multiply, screen, overlay, darken, lighten,
color-burn, color-dodge, soft-light, hard-light, difference and exclusion. Layer styles
reuse effect records; `drop-shadow.spread` is optional and defaults to zero. See
[layer effects and blending options](LAYER_STYLES.md) for compatibility and automation.

Layers use stable UUIDs, time bounds, kind, blend mode, transform properties, and
effects. An animatable property is either a static value or an ordered keyframe array. Effects are
identified by a stable type string and numeric parameter map so missing plugins can remain round-trip
safe. An effect may carry per-parameter ordered keyframe tracks without changing its static fallback
map. The `multi-stop-gradient` effect uses five packed RGB colors (`color1` through `color5`),
three interior stop percentages (`position2` through `position4`), normalized target-space endpoint
percentages (`startX`, `startY`, `endX`, `endY`), `interpolation` (0 linear, 1 smooth), and `blend`.
`mapping` selects linear (0, default), radial (1), or clockwise angular (2) projection. In radial
mode the first point is the center and the second defines the radius; angular mode uses that vector
as the zero-angle ray. Older projects without `mapping` retain the linear ramp.
Endpoints can extend outside the target. Interior stops are stably sorted with their colors at each
evaluation; coincident stops form a hard transition. Color keyframes interpolate RGB channels
independently using their stored easing. Stops interpolate in sRGB, then convert to the linear render
target; endpoint projection accounts for the target aspect ratio. The effect preserves source alpha
and needs no new media.
Precomposition layers reference another composition by stable ID. Development image/video
imports may use bounded `data:` URLs for portable single-file projects; the native bundle layer will
externalize large media into an asset directory without changing layer references. Version 4 stores
footage once in the project-level `sources` registry. Image and video layer instances reference it by
stable `sourceId`, so duplication, parenting, effects, and timeline edits never copy encoded bytes.

New precompositions preserve the source composition's time coordinates. Their wrapper retains the
selected `[inPoint, outPoint)` span and stores `timeOffset = inPoint`, so parent time `t` samples
nested time `t`. The nested duration reaches the selection's end; its work area begins at the
selection's start. The leading timeline interval is outside that work area and does not extend the
wrapper or parent output. Keyframes before the selected span remain intact, preserving interpolation
and easing at the cut. Transform, camera, path morph, shape graph, effect, time-remap and text animator
tracks, expressions and procedural clocks therefore retain their original frame addresses without
rewriting. Existing precompositions keep their persisted time mapping; this requires no migration.
Opening a composition, including the active composition of a loaded project, positions the editor
at its work-area start with playback stopped. Its original frame numbering remains visible without
requiring the user to seek through the leading interval.

A 2D precomposition with an enabled wrapper effect is rendered to the existing bounded GPU surface
before applying that effect to the combined image and alpha. Ordinary 2D groups remain flattened;
disabling all wrapper effects restores that path. This uses existing layer/effect fields and does not
change schema version 10. Adjustment layers inside such an isolated source remain local to it, as
they do for 3D surface wrappers. Surface limits and diagnostics are unchanged. Mirroring a 2D parent
or wrapper reverses descendant Z rotations as well as positions, keeping articulated joints attached.

Sources are discriminated as `still`, `video`, `audio`, `imageSequence`, `svg`, or `psd`. Every source
has a stable ID, MIME type, bounded content identity, optional embedded/relative/runtime locator, and
explicit alpha/color-space/frame-rate interpretation. Kind-specific dimensions, durations, channel
metadata, sequence ranges, and PSD layer counts are bounded before use. Current importers produce
all six source kinds. Audio admits bounded WAV, MP3, AAC, M4A, OGG, and
FLAC inputs only after the browser decoder proves support; the native link boundary records the
selected stream index, channel count, and sample rate from FFprobe. Importers implement the fixed
`probe`, `validate`, and `import` contract and must validate before admitting a source.

## Recoverable project media

SVG, PSD, image-sequence, still, video, and audio import state is runtime-owned, but version 10 project
documents may carry a bounded `mediaImports` sidecar that can recreate it. Entries map stable source
IDs to a deduplicated payload table. SVG payloads retain sanitized vector markup for
resolution-independent rerasterization. Every PSD layer stores only its import mode and stable layer
key; all layers from the same document reference one compressed original document payload. Sequence
payloads retain immutable pattern, rational frame-rate, missing-frame policy, and per-frame identity
metadata. Picker-imported still, video, and audio payloads retain their MIME type and safe extension;
their source metadata stays small and no encoded file body is stored in the source object.

Browser JSON downloads and browser recovery snapshots embed at most 128 MiB of validated payload
bytes. Native saves and autosaves accept only picker-authorized external inputs, verify byte identity
while streaming, and atomically materialize content-addressed files below `assets/imports`. Persisted
`project.json` contains only bundle-relative paths and identities: absolute paths, `blob:` URLs,
`aster-asset:` URLs, decoded PSD planes, and load-only `resolvedPath` fields are never written. Native
load canonicalizes every path, rejects traversal, symbolic links, junction/reparse points, missing
files, mutations, kind mismatches, and bound mismatches before atomically replacing the runtime
registry. Packed `.aster` archives therefore remain usable after the originally imported files move
or are deleted.

Legacy sources with bounded `dataUrl` locators remain readable. Their next native save migrates the
decoded bytes through the same identity-checked sidecar and writes only the resulting relative bundle
asset to disk. New desktop imports retain the picker-authorized source path until that first save, so
large audio and video files never require a base64 copy in the project document or undo history.

Managed import files are content-addressed and shared by primary saves and recovery autosaves. Save
does not delete unreferenced files because an older recovery snapshot may still reference them; pack
currently includes those conservative stale files. A future garbage collector must trace both the
primary document and every recoverable autosave before reclaiming them.

Version 5 gives audio-bearing layers a required `audio` object with stereo `levelsDb`, `pan`, `muted`,
and `reversed` fields. Audio-only layers use `kind: "audio"`, never emit visual geometry, and reference
an `audio` source. Video layers may reference optional embedded audio stream metadata and use the same
audio controls. The layer `audioEnabled` switch remains independent of visual visibility and soloing
is evaluated in separate audio and video layer groups.

Null and solid layers have explicit source semantics. A `null` remains selectable, parentable,
time-addressable, and 2D/3D-transformable, but emits no render geometry; effects attached to it are
preserved without producing pixels. A `solid` owns required `solid` settings containing integer
`width` and `height` from 1 through 30000 plus four normalized RGBA channels. The legacy generic
`size` and `color` fields mirror those settings for common tooling and are rejected when they drift;
the dedicated settings are the canonical solid source persisted through copy/save operations.

GPU-generated content uses the generic `generator` layer kind. The project stores only a portable
plugin reference and bounded parameter values; GPU pipelines and buffers remain runtime-owned:

```json
{
  "kind": "generator",
  "generator": {
    "pluginId": "org.aster.builtin.particles",
    "nodeType": "particle_system",
    "apiVersion": 1,
    "parameters": { "count": 100000, "renderMode": "billboard" }
  }
}
```

Unknown, disabled, or missing generator plugins remain round-trip safe. The layer renders as an
isolated missing-plugin node until the matching `(pluginId, nodeType, apiVersion)` is available. The
project reader validates only the bounded, portable parameter envelope; the matching plugin manifest
owns parameter names, types, ranges, defaults, and execution-time clamping. This keeps project I/O
independent of installed plugins and preserves data during plugin recovery or downgrade.

The project panel stores organizational bins in `folders`. A folder has a stable ID, a
bounded display name, and an optional `parentId` for nesting. `itemFolderIds` maps composition IDs or
footage source IDs to their containing folder. These fields affect project-panel organization
only: rendering data remains on compositions and layers, so moving an item between folders never
copies media or invalidates GPU resources. Readers hydrate both fields as empty for early version 1
documents, reject missing parents and folder cycles, and preserve the organization through saves,
autosaves, and undoable project operations.

Version 1 added a bounded serialized command log. Each entry records its stable ID, timestamp, source,
summary, and operation type manifest. Transactions of at most 100 operations and 32 KiB also retain
replayable operation JSON. Larger transactions retain a bounded list of distinct operation types
without a partial replay payload; their editor undo remains atomic. The writer keeps at most 100
entries and 256 KiB total, so large imported layers are never duplicated into project history.

A 3D LUT effect may embed one bounded `lut3d` resource containing its display name, 2–64 cube size,
RGB voxel data, input domain, and checksum. Readers validate the exact `size³ × 3` channel count and
finite channel bounds before allocating a GPU texture.

Imported meshes may carry one tangent `xyzw` tuple per vertex and bounded embedded
material textures. Normal maps use PNG, JPEG, or WebP data URLs, texture coordinate set zero, and an
optional scale from -8 through 8. Every tangent must have finite, non-negligible xyz length and
handedness exactly -1 or 1. Tangents, UVs, normal-map scale, and source dimensions are validated
before the material enters the GPU path. HDR imports are fully decoded and validated in a cancellable
worker before their source is admitted to the project document.

Camera layers store one-node/two-node mode, animated point of interest and orientation vectors,
horizontal film size, Zoom in composition pixels, orthographic size, and bounded
depth-of-field optics. Derived focal length and f-stop are never persisted, preventing animation
and UI edits from creating inconsistent lens state. The default 50 mm camera is centered one Zoom
behind the composition plane. At a given time, the first camera in timeline order whose in/out span
contains that time is active; its visibility switch does not create a drawable surface. Beauty
preview and export evaluate the same camera, world-position pass, circle-of-confusion function, and
ACES display transform. Preview resolution only scales the sampling radius. This follows Adobe's
[camera and point-of-interest model](https://helpx.adobe.com/after-effects/using/cameras-lights-points-interest.html)
and [Advanced 3D depth-of-field controls](https://helpx.adobe.com/after-effects/desktop/work-with-3d-composition/work-with-3d-scene-depth-data/enable-in_engine-depth-of-field-in-advanced-3d.html).

## Schema and migration policy

- Readers clone the input and pass it through a sequential `vN -> vN+1` migration registry before
  validating the current `schemaVersion`. The v1 → v2 migration converts legacy `particle` layers
  into `generator` layers backed by `org.aster.builtin.particles` without changing IDs, timing,
  transforms, cloners, or settings. The v2 → v3 migration establishes the explicit null/solid layer
  vocabulary without rewriting existing layers. The v3 → v4 migration lifts nested image/video
  assets into `sources`, deduplicates exact repeated content, and replaces each nested payload with a
  stable `sourceId`. The v4 → v5 migration adds first-class audio-layer settings, maps the legacy
  normalized audio gain to stereo decibels, and supplies selected-stream metadata for audio sources.
  The v5 → v6 migration converts legacy vertical-FOV cameras to a physical film-back/Zoom lens,
  offsets their camera position by the migrated Zoom so the composition plane remains visible, and
  supplies deterministic one-node and depth-of-field defaults.
  The v6 → v7 migration adds a disabled composition Motion Blur switch with the centered 180/-90
  shutter defaults and disables the switch on every existing layer, preserving all previous pixels.
  The v7 → v8 migration converts each legacy staggered text reveal to one deterministic animator
  group with an equivalent bounded expression selector; layer IDs derive stable group and selector
  IDs, and the cubic reveal remains pixel-equivalent at arbitrary seek times.
  The v8 → v9 migration turns every static camera optical scalar into a static `Animatable`, removes
  redundant focal-length and f-stop storage, and adds deterministic iris and highlight defaults.
  Zoom, film size, and Aperture pixels are authoritative; focal length and f-stop are derived at
  the requested evaluation time. Aperture conversion uses Adobe's 72-dpi convention
  (`focalLengthMm / fStop × 72 / 25.4`), locking the 50 mm f/5.6 baseline to 25.31 px.
  The v9 → v10 migration centers every layer anchor before the GPU and Canvas renderers begin
  applying anchor offsets. This preserves legacy pixels while making preview outlines, hit testing,
  inline text editing, direct manipulation, and rendered geometry share one local transform.
  Older, future, missing, or fractional versions fail
  before partially applying the document.
- The native bundle boundary accepts v1 through v10 on read so the renderer can run migrations, but
  new primary saves and autosaves must already be validated v10 documents.
- Every future historical transform must preserve the source document, set exactly the next integer
  version, and gain a compatibility fixture before the current schema version increases.
- Unknown effect types and parameters must be preserved and disabled when execution is unavailable.
- IDs are stable across saves; duplicate/copy operations issue new IDs.
- Relative asset paths resolve against the project directory and may not escape it after
  canonicalization.
- Parent and precomposition references must resolve, and precomposition cycles are rejected during
  evaluation.

## Atomic save

Write and validate a sibling temporary file, flush it, move the previous project to a backup, replace
the target, and remove the backup only after success. A startup recovery pass may offer a valid newer
temporary/autosave file; it never silently overwrites the source. The native filenames are
`project.json` and `project.autosave.json`; unsaved or browser-only projects keep an equivalent
validated recovery snapshot in local storage, which is also the fallback when a native autosave
fails. Recovery autosaves run after the configured idle interval, at least once per minute during
continuous editing, and when the editor moves into the background while autosave is enabled. They
never advance the primary saved revision.
Bezier `shape` settings may contain an optional `morph` object with a topology-compatible `target` path and an `Animatable` percent `progress`. This additive field uses the existing project version; see [Path morph](PATH_MORPH.md).

# Aster project format v4

The development editor currently exchanges a readable JSON document named `*.aster.json`. The Rust
bundle layer stores the same versioned domain model inside an atomically replaced project path. Cache,
proxy, and preview data are deliberately excluded.

## Required root fields

```json
{
  "schemaVersion": 4,
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

Layers use stable UUIDs, time bounds, kind, blend mode, transform properties, and
effects. An animatable property is either a static value or an ordered keyframe array. Effects are
identified by a stable type string and numeric parameter map so missing plugins can remain round-trip
safe. An effect may carry per-parameter ordered keyframe tracks without changing its static fallback
map. Precomposition layers reference another composition by stable ID. Development image/video
imports may use bounded `data:` URLs for portable single-file projects; the native bundle layer will
externalize large media into an asset directory without changing layer references. Version 4 stores
footage once in the project-level `sources` registry. Image and video layer instances reference it by
stable `sourceId`, so duplication, parenting, effects, and timeline edits never copy encoded bytes.

Sources are discriminated as `still`, `video`, `audio`, `imageSequence`, `svg`, or `psd`. Every source
has a stable ID, MIME type, bounded content identity, optional embedded/relative/runtime locator, and
explicit alpha/color-space/frame-rate interpretation. Kind-specific dimensions, durations, channel
metadata, sequence ranges, and PSD layer counts are bounded before use. Current importers produce
`still` and `video`; the other discriminants reserve compatible project data without claiming a
decoder. Importers implement the fixed `probe`, `validate`, and `import` contract and must validate
before admitting a source.

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

The project panel stores AE-style organizational bins in `folders`. A folder has a stable ID, a
bounded display name, and an optional `parentId` for nesting. `itemFolderIds` maps composition IDs or
footage source IDs to their containing folder. These fields affect project-panel organization
only: rendering data remains on compositions and layers, so moving an item between folders never
copies media or invalidates GPU resources. Readers hydrate both fields as empty for early version 1
documents, reject missing parents and folder cycles, and preserve the organization through saves,
autosaves, and undoable project operations.

Version 1 added a bounded serialized command log. Each entry records its stable ID, timestamp, source,
summary, and operation type manifest. Transactions of at most 32 KiB also retain replayable operation
JSON. The writer keeps at most 100 entries and 256 KiB total, so large imported layers are never
duplicated into project history.

A 3D LUT effect may embed one bounded `lut3d` resource containing its display name, 2–64 cube size,
RGB voxel data, input domain, and checksum. Readers validate the exact `size³ × 3` channel count and
finite channel bounds before allocating a GPU texture.

Imported meshes may carry one tangent `xyzw` tuple per vertex and bounded embedded
material textures. Normal maps use PNG, JPEG, or WebP data URLs, texture coordinate set zero, and an
optional scale from -8 through 8. Every tangent must have finite, non-negligible xyz length and
handedness exactly -1 or 1. Tangents, UVs, normal-map scale, and source dimensions are validated
before the material enters the GPU path. HDR imports are fully decoded and validated in a cancellable
worker before their source is admitted to the project document.

## Schema and migration policy

- Readers clone the input and pass it through a sequential `vN -> vN+1` migration registry before
  validating the current `schemaVersion`. The v1 → v2 migration converts legacy `particle` layers
  into `generator` layers backed by `org.aster.builtin.particles` without changing IDs, timing,
  transforms, cloners, or settings. The v2 → v3 migration establishes the explicit null/solid layer
  vocabulary without rewriting existing layers. The v3 → v4 migration lifts nested image/video
  assets into `sources`, deduplicates exact repeated content, and replaces each nested payload with a
  stable `sourceId`. Older, future, missing, or fractional versions fail
  before partially applying the document.
- The native bundle boundary accepts v1 through v4 on read so the renderer can run migrations, but
  new primary saves and autosaves must already be validated v4 documents.
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

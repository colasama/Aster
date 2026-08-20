# Aster project format v1

The development editor currently exchanges a readable JSON document named `*.aster.json`. The Rust
bundle layer stores the same versioned domain model inside an atomically replaced project path. Cache,
proxy, and preview data are deliberately excluded.

## Required root fields

```json
{
  "schemaVersion": 1,
  "id": "stable-uuid",
  "name": "Project name",
  "activeCompositionId": "stable-uuid",
  "compositions": [],
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
externalize large media into an asset directory without changing layer references.

The project panel stores AE-style organizational bins in `folders`. A folder has a stable ID, a
bounded display name, and an optional `parentId` for nesting. `itemFolderIds` maps composition IDs or
source-backed layer IDs to their containing folder. These fields affect project-panel organization
only: rendering data remains on compositions and layers, so moving an item between folders never
copies media or invalidates GPU resources. Readers hydrate both fields as empty for early version 1
documents, reject missing parents and folder cycles, and preserve the organization through saves,
autosaves, and undoable project operations.

Version 1 adds a bounded serialized command log. Each entry records its stable ID, timestamp, source,
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

## MVP schema policy

- Readers accept only the current `schemaVersion` and reject older, future, missing, or fractional
  versions before partially applying them. The MVP intentionally provides no legacy migrations.
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
`project.json` and `project.autosave.json`; the browser editor keeps an equivalent validated recovery
snapshot in local storage.

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
  "commandLog": [],
  "updatedAt": "2026-08-20T00:00:00.000Z"
}
```

A composition declares dimensions, rational frame rate, duration, linear RGBA background, and an
ordered layer list. Layers use stable UUIDs, time bounds, kind, blend mode, transform properties, and
effects. An animatable property is either a static value or an ordered keyframe array. Effects are
identified by a stable type string and numeric parameter map so missing plugins can remain round-trip
safe. An effect may carry per-parameter ordered keyframe tracks without changing its static fallback
map. Precomposition layers reference another composition by stable ID. Development image/video
imports may use bounded `data:` URLs for portable single-file projects; the native bundle layer will
externalize large media into an asset directory without changing layer references.

Version 1 adds a bounded serialized command log. Each entry records its stable ID, timestamp, source,
summary, and operation type manifest. Transactions of at most 32 KiB also retain replayable operation
JSON. The writer keeps at most 100 entries and 256 KiB total, so large imported layers are never
duplicated into project history.

A 3D LUT effect may embed one bounded `lut3d` resource containing its display name, 2–64 cube size,
RGB voxel data, input domain, and checksum. Readers validate the exact `size³ × 3` channel count and
finite channel bounds before allocating a GPU texture.

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

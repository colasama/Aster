# Desktop application foundations

Aster's Electron shell owns operating-system integration and durable application preferences. The
sandboxed renderer owns editor interaction state, while project documents continue to cross the
validated Rust bridge boundary for native filesystem persistence.

## Application preferences

Electron stores `preferences.json` below `app.getPath("userData")`. The document is versioned,
validated on every read and update, written through a flushed sibling temporary file, and recovered
from a backup when the primary document is invalid. Renderer IPC can update only user-facing
preferences; window state, recent projects, and the last project path remain main-process-owned.

Version 1 contains:

- interface locale, reduced-motion preference, and GPU memory budget;
- the recovery-autosave interval;
- up to ten normalized recent project paths; and
- bounded window position, size, and maximized state.

The preferences migration boundary upgrades the previous unversioned shape as version zero. A new
desktop profile also imports the renderer's legacy locale, autosave, reduced-motion, and GPU-budget
keys exactly once before Electron becomes authoritative. Future changes must add one deterministic
`vN -> vN+1` transform and tests before increasing the current version. API keys, access tokens,
prompts, project contents, and other secrets do not belong in this document.

## Window and file lifecycle

Aster holds Electron's single-instance lock. A second launch forwards packed `.aster` paths to the
existing window, which restores and focuses before processing them. macOS `open-file` and command-line
file activation use the same bounded queue. Installer metadata registers `.aster` as an editable
Aster project type.

Window bounds are saved after bounded move/resize debouncing and on close. Restored bounds are
clamped to a current display work area, so disconnecting a display cannot strand the window
off-screen. Maximized state is stored independently from normal bounds.

The editor reports the current project name and dirty state to Electron. Closing a dirty document,
creating another project, opening a project, or accepting an operating-system open request uses the
same Save / Don't Save / Cancel contract. A primary save records the exact editor revision that was
written. If editing continues while that save is in flight, the newer revision remains dirty.

## Recovery autosave

Recovery autosave never marks a document clean and never replaces the primary `project.json`.

- After a project edit, Aster writes a validated recovery snapshot after the configured 15, 30, or
  60 second idle interval.
- A separate 60 second maximum interval protects projects during continuous editing.
- When autosave is enabled, moving the application into the background requests an immediate
  snapshot.
- Native projects use `project.autosave.json`; unsaved and browser-only projects use a validated
  local recovery document. If native autosave fails, the renderer attempts that local fallback.
- Native primary saves and autosaves share one persistence queue so a late autosave cannot recreate a
  stale recovery file after a successful save.

On startup, Aster checks both the local recovery document and the last native project's newer
`project.autosave.json`. It verifies the project identity and reopens the matching bundle before
applying native recovery, which preserves relative asset resolution. If the renderer process exits
unexpectedly, active export and AI work is cancelled and a native Reload and Recover action restarts
the renderer.

## Schema migrations

Three persistence domains have independent version boundaries:

1. Application preferences migrate the legacy unversioned document to version 1.
2. Plugin preferences migrate the legacy unversioned document to version 1 before plugin discovery.
3. Project loading runs through a sequential migration registry. The v1 to v2 transform converts
   legacy `particle` layers into built-in `generator` layers while preserving their identity,
   timing, transforms, cloners, and settings. Older unsupported or future versions fail without
   modifying their source document.

Migrations must be deterministic, operate on a clone, validate their output version, preserve a
recoverable original, and have fixtures for every supported source version.

## Diagnostics and privacy

Help > Export Diagnostics writes a user-selected, bounded JSON report containing the Aster version,
platform, architecture, GPU feature status, basic GPU information, non-sensitive preference values,
and the latest bounded structured log entries. Recent project paths and the last project path are not
copied from preferences into the report. The export is local and never uploads automatically.

Crash reporting remains opt-in and unimplemented. Diagnostic export, analytics consent, update
consent, and crash-upload consent are separate product decisions.

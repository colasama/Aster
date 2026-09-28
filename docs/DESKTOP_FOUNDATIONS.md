# Desktop application foundations

Aster's Electron shell owns operating-system integration and durable application preferences. The
sandboxed renderer owns editor interaction state, while project documents continue to cross the
validated Rust bridge boundary for native filesystem persistence.

## Development startup

Vite 8 full-bundle development mode is enabled because the editor has a broad GPU and effect module
graph. Request-by-request pre-transformation delayed the first renderer mount until the whole graph
had completed a transform waterfall; Rolldown now creates one development bundle while retaining
Vite reload and Fast Refresh behavior. Production-only manual chunk groups are not applied to this
development bundle because the built-in Scene Generator registry has an intentional cross-module
initialization order.

Full-bundle development is enabled by default. Set `ASTER_BUNDLED_DEV=0` (also accepts `false`,
`no`, or `off`) to fall back to Vite's request-by-request server when diagnosing an experimental
bundler or HMR compatibility problem. The setting can be supplied by the process environment or an
untracked `.env.development.local` file. Remove the setting, or use `1`, `true`, `yes`, or `on`, to
restore the default. For example:

```powershell
$env:ASTER_BUNDLED_DEV = "0"
pnpm dev
Remove-Item Env:ASTER_BUNDLED_DEV
```

`pnpm dev` and its `pnpm electron` alias build the Rust bridge and Electron main/preload bundle, then
start Vite before launching Electron. A clean checkout therefore never depends on ignored or stale
bridge, `dist-electron`, or development-server output.

The switch only affects the development server. It does not change production chunking, packaged
artifacts, or plugin runtime activation.

React development `StrictMode` is not wrapped around the editor root. Its deliberate mount/unmount
replay would create two WebGPU devices and prewarm the same pipelines twice; GPU resource ownership
is instead covered by explicit lifecycle tests and renderer diagnostics.

## Application preferences

Electron stores `preferences.json` below `app.getPath("userData")`. Unpackaged development runs use
an `Aster Development` profile below the platform app-data directory so their preferences, logs,
single-instance lock, and Chromium session cache cannot collide with an installed Aster build. An
explicit Chromium `--user-data-dir` remains authoritative for isolated automation and diagnostics.
The preferences document is versioned, validated on every read and update, written through a flushed
sibling temporary file, and recovered from a backup when the primary document is invalid. Renderer
IPC can update only user-facing preferences; window state, recent projects, and the last project path
remain main-process-owned.

Version 1 contains:

- interface locale, reduced-motion preference, and GPU memory budget;
- the recovery-autosave interval;
- up to ten normalized recent project paths; and
- bounded window position, size, and maximized state.

Versions 2 and 3 add UI scale and anti-aliasing respectively. Version 4 adds `viewportNavigationMode`
(`smooth` or `legacy`), defaulting existing profiles to `smooth`. This application preference is
restored by the editor, takes effect when preferences are saved, and is not part of project files.

Version 5 adds `gpuPreference`: `high-performance` (the default) or `low-power`. The GPU selector
in Preferences saves the choice for the next application start (page reload in web development).
Before Electron's ready event, Aster reads the profile, including backup recovery, and applies
`force_high_performance_gpu` or `force_low_power_gpu`. Preview, export hosts, and memory detection
also pass the saved preference to WebGPU adapter requests. Existing GPU resources remain on their
current device until restart. GPU selection is a platform-dependent preference, not an adapter-ID
selector; systems with one compatible GPU may use the same device for both choices.

`gpuMemoryBudgetMb` accepts `auto` or any integer of at least 32 MiB. Settings constrain manual
values to the detected capacity of the active rendering adapter; runtime resolution also caps
saved values when moving to a smaller GPU. Manual values are the actual budget, without an
additional reserve deduction. Values above currently free memory remain selectable with a warning.

Automatic mode samples estimated free GPU memory at renderer initialization or an explicit settings
refresh. Its budget is `floor((freeMiB - 1024) / 1024) * 1024` MiB. Below 2 GiB free, it uses half
the free memory, rounded down to MiB and capped at 512 MiB. Missing free-memory information uses
512 MiB, capped by any known physical capacity, and is identified in settings. Sampling is outside
the frame loop: repeatedly subtracting Aster's own allocations from a free-memory snapshot would
shrink its target as it fills its caches.

Windows detection matches DXGI adapter identities to WDDM adapter-memory counters by LUID.
Direct3D 12's `D3D12_FEATURE_ARCHITECTURE.UMA` identifies unified-memory adapters, including AMD
780M-class integrated GPUs; neither vendor names nor small VRAM capacities identify UMA reliably.
For confirmed UMA adapters, capacity includes DXGI dedicated video/system memory plus shared
system memory. Free memory is the unused dedicated portion plus the smaller of unused shared
capacity and currently available physical system RAM. Shared capacity is not a free-memory
measurement. Missing usage counters retain the conservative automatic fallback while preserving
the detected capacity for manual configuration. If the architecture query fails, detection retains
dedicated capacity only. Discrete GPUs continue to use dedicated capacity minus dedicated usage.
Probes create a short-lived D3D12 device outside the frame loop and release it immediately.
Linux uses NVIDIA's driver utility or DRM VRAM counters when available; shared-memory detection
for Linux integrated GPUs is not yet supported. macOS exposes detected capacity; Apple silicon is
explicitly labeled shared system memory. These macOS probes do not provide a reliable free-memory
measurement, so automatic mode uses the fallback there. WebGPU adapter identity selects the device;
multiple adapters are never added together. Undetectable capacity disables manual editing.

The isolated export renderer has read-only access to the same preferences and detection IPC.
Both preview and export resolve their budget before allocating composition targets. These budgets
guide Aster's existing allocation planners and caches; they do not reserve physical VRAM or cap
Chromium's entire GPU process. Other applications can change memory availability after sampling.

The preferences migration boundary upgrades the previous unversioned shape as version zero. A new
desktop profile also imports the renderer's legacy locale, autosave, reduced-motion, and GPU-budget
keys, anti-aliasing, and preview navigation exactly once before Electron becomes authoritative.
Future changes must add one deterministic `vN -> vN+1` transform and tests before increasing the
current version. API keys, access tokens,
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
written. If editing continues while that save is in flight, the newer revision remains dirty. A new
project starts clean, and opening another composition is navigation rather than an edit, so neither
triggers the unsaved-changes prompt nor an undo step.

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

Recovery snapshots are silent: the title bar only reports a failed snapshot, and the unsaved-changes
dot shows the time of the latest snapshot as its tooltip. A snapshot is not a save, so the document
stays dirty until the user saves it.

On startup, the desktop app resumes the project that was open when it last quit. It checks both the
local recovery document and that project's newer `project.autosave.json`, verifies the project
identity, and reopens the matching bundle before applying native recovery, which preserves relative
asset resolution. Without a snapshot the last project simply reopens clean; declining a snapshot
discards it and opens the last saved version instead of the startup demo. A recovered snapshot of a
different, untitled document is detached from the last project's folder so saving it cannot
overwrite that project. If the renderer process exits unexpectedly, active export and AI work is
cancelled and a native Reload and Recover action restarts the renderer.

## Schema migrations

Three persistence domains have independent version boundaries:

1. Application preferences migrate the legacy unversioned document to version 1.
2. Plugin preferences migrate the legacy unversioned document to version 1 before plugin discovery.
3. Project loading runs through a sequential migration registry. The v1 to v2 transform converts
   legacy `particle` layers into built-in `generator` layers while preserving their identity,
   timing, transforms, cloners, and settings. The v2 to v3 transform introduces explicit null and
   solid source semantics without rewriting prior layers. The v3 to v4 transform deduplicates nested
   image/video payloads into the project footage registry and installs stable layer references. Older unsupported or future versions fail without
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

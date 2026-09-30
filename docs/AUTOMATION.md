# External automation and video reconstruction

Aster 0.3.5 exposes the running desktop editor to external agents through an MCP stdio adapter.
The adapter reuses the same command definitions and staged application service as the built-in Pi
agent. Reference decoding uses FFmpeg/FFprobe; imports, persistence and rendering use existing Aster
services. No model credentials are needed to operate these tools.

## Start a local connection

Aster provides two local modes. Neither requires a token or model credentials.

### Connect to the interactive editor

Open **Preferences → MCP**, enable MCP, and choose **Copy client configuration**.
The switch applies immediately and persists across restarts. The port defaults to `48765`;
**Apply port** changes it. A failed change restores the previous working listener.
Keep the editor running while using its connection.

For an installed package, the client launches:

```json
{
  "mcpServers": {
    "aster": {
      "command": "C:/path/to/Aster/resources/bin/aster-mcp.exe",
      "args": []
    }
  }
}
```

If the port differs, set `ASTER_AUTOMATION_PORT` in this server's environment.
For a source checkout, run `pnpm build`, use `pnpm mcp` to connect through the Node stdio adapter; `pnpm mcp --background`
starts an isolated editor from the production assets.
The interactive development editor starts with `pnpm dev`.

### Start an independent background editor

Add `--background` to the launcher arguments. The client launches a hidden, GPU-capable editor on demand,
using a temporary profile and an automatically assigned loopback port. No editor window needs
to be open and no MCP preference needs to be enabled first. The same query, staged editing,
preview, media, saving and export tools are available. Use `open_project` to load a native
project directory, and explicitly save changes and wait for exports before disconnecting.
This session never takes over an existing interactive document. Closing the MCP connection
stops its owned background editor and removes the temporary profile.

```json
{
  "mcpServers": {
    "aster-background": {
      "command": "C:/path/to/Aster/resources/bin/aster-mcp.exe",
      "args": ["--background"]
    }
  }
}
```

Background startup can take up to 60 seconds; use a client startup timeout of 90 seconds
and a tool timeout of 130 seconds. GPU work reuses the Electron/WebGPU renderer in a hidden
window, rather than a separate CPU renderer. On Linux a working graphical/GPU environment is
still required. Sessions start from the default document and do not automatically save on exit.

### Local transport and preferences

The public MCP transport is stdio. Its internal HTTP bridge binds exclusively to `127.0.0.1`;
it is not an MCP HTTP endpoint. Requests with browser Origin/Fetch Metadata headers, unexpected
Host headers, or non-JSON POST content types are rejected. The opt-in listener trusts local
non-browser processes; there is no token authentication. It retains bounded requests, schema
validation, revision checks, explicit commits, cancellation and destination overwrite checks.

Settings live in `automation.json` in the application profile. Version 2 stores only enabled
state and port. Version 1 preferences remain readable without decrypting their obsolete token;
the next settings save writes version 2. For managed interactive sessions, set
`ASTER_AUTOMATION_ENABLED=1` (or `0` to disable) and optionally `ASTER_AUTOMATION_PORT` before
starting Aster. Environment-managed settings are read-only in Preferences.
The former `ASTER_AUTOMATION_TOKEN` is no longer used. `ELECTRON_RUN_AS_NODE` is unnecessary
in client configuration: the native launcher runs the bundled adapter under Electron's Node mode.
The direct adapter script can also run under Node.

## Tools

Each concern is one tool. Tools with several operations take an `action` (or `topic`); missing
fields are reported by name. The built-in Pi agent uses the first nine tools; the rest are external
automation tools.

| Tool | Behavior |
| --- | --- |
| `get_editor_context` | Read the live revision and active composition. External clients pass `reset: true` after user edits to discard their staged workspaces and script modules and capture the current editor. |
| `describe` | `topic: "script"` returns the script API cheat sheet (methods, property paths, expression functions, text animators, time mapping, colors, budgets, common errors). `topic: "commands"` ranks typed commands by intent words (synonyms such as delete→remove, footage→source, lyric→text animator; no query or no match returns the name index by category) and includes matching effect types; `names` returns exact input schemas. `topic: "effects"` lists effect types with parameter keys, defaults and ranges. |
| `query_project` | Read bounded, paginated project slices. `compositions` lists every composition (nested ones included) with layer/marker counts and parents; `layers`, `properties`, `effects`, `markers` and `scene` read the active composition or `compositionId`; `query` filters by name; `nextOffset` marks further pages; `workspace` reports a workspace's revision, state, operation/byte budgets and expiry. `projectRevision` is optional for live reads. |
| `execute_aster_code` | Stage edits in one call: `code` runs a script, `commands` applies 1–256 typed commands atomically. `baseRevision` starts a workspace; `workspaceId` + `workspaceRevision` continue one. Waits for completion by default. External clients may add `commit: true`. |
| `get_execution` | Wait for and read a script's status; `cancel: true` terminates it. |
| `render_preview` | Render staged frames (video layers decoded to the exact frame) with per-frame metrics. `contactSheet: { start, end, count \| interval \| times, columns, cellWidth }` tiles up to 64 labeled samples into one image. Samples that are completely black while layers are active, or over a non-black background, return `warnings`. |
| `diagnostics` | `action: "inspect"` lists unresolved assets and invalid timing; `"analyze"` measures sampled workspace frames; `"evaluate"` returns evaluated properties and scene state at one time. |
| `submit_workspace`, `discard_workspace` | Review a compact diff (operation counts by type; `verbose: true` lists every operation), or destroy a workspace. |
| `commit_workspace` | Merge a workspace as one undoable edit; an unsubmitted workspace is submitted automatically. A changed live revision blocks commit. |
| `import_assets` | Import up to 32 images, videos, audio files, SVG, PSD compositions or embedded glTF/GLB files (`paths`, or one `path`) into the active composition, one undoable edit each, with per-file layer IDs or errors. `hidden: true` adds switched-off layers; `audioEnabled: false` silences video layers, and video without a decodable audio stream is silenced automatically. |
| `relink_source` | Replace a still, video or audio source with another local file of the same kind (for example a higher-resolution render). Every layer using it, in every composition, is retargeted as one undoable edit; the old source is removed unless `removeOld: false`. Returns the new `sourceId`. |
| `open_project`, `save_project` | Open an absolute native bundle directory at `baseRevision` without a file dialog (loads fonts and media, resets history, invalidates workspaces; save first; unpack `.aster` files first). Save an exact revision and collect media into a bundle directory; omit `path` to save back to the current bundle; replacing another existing `project.json` requires `overwrite: true`. |
| `render` | `action: "export"` queues an immutable MP4, PNG sequence or still snapshot and returns only that job; `"wait"` blocks until it settles (up to 100 s per call) and reports black segments of MP4 outputs (FFmpeg `blackdetect`, limited-range aware) or still luminance (`analyze: false` skips); `"status"` lists compact jobs newest first or one `jobId`; `"cancel"` stops a job. |
| `reference` | `action: "probe"` returns FFprobe metadata for an absolute local path; `"frames"` returns PNG frames with actual decoded timestamps, or one labeled `contactSheet` of up to 64 samples (for example `{ "interval": 5 }` across the file), seeking directly to each sample; `"audio"` returns a bounded mono 16 kHz WAV excerpt; `"compare"` returns reference/render pairs, 50% overlays, difference images and normalized RGB error. |
| `analyze_beats` | Estimate BPM, a constant-tempo beat grid (offset of beat zero), downbeats and loudness-based sections from project audio (`layerId` maps results onto the composition through the layer's in point and time mapping; `sourceId` reports source time) or a local file (`path`, decoded with FFmpeg). Returns ready-to-paste expressions such as `pow(1 - beatphase(bpm, offset), 3)`. `writeMarkers: true` with `baseRevision` writes beat, downbeat and section markers into the composition as one undoable edit and keeps custom markers. |
| `fonts` | `action: "list"` lists system faces and embedded project fonts (`source`, `query`, `offset`/`limit` up to 128; metadata only); `"check"` checks 1–64 exact family names against project fonts and Chromium's system inventory (heuristic `fallback-metrics` results are labeled; no glyph-coverage guarantee); `"import"` embeds a local TTF/OTF/WOFF/WOFF2 face with a `family` alias and `weight` (default 400) or variable `weightRange` at `baseRevision` as one undoable edit, project-only. |
| `script_modules` | `action: "put"` stores a helper library for `aster.require(name)`; `"remove"` deletes it; `"list"` shows names and sizes. Modules belong to the connection. |

Images and audio are returned as native MCP content blocks. Text metadata identifies content indices
without duplicating base64 data.

## Reconstruction loop

1. Probe the reference, sample meaningful times, and read short audio excerpts when timing matters.
2. Read the live revision and `describe` (`topic: "script"`) once. Import media with `import_assets`; imports
   reset this client's edit session but keep its script modules.
3. Run `execute_aster_code` with `baseRevision`; the call returns the settled status, result and
   warnings. Store shared helpers with `script_modules` instead of resending them.
4. Render or compare at explicit times using the returned `workspaceRevision`. Adjust and repeat.
5. Commit with `commit_workspace` (it submits automatically), or pass `commit: true` to the script
   call when no preview is needed. Continue from the returned `projectRevision`.
6. Save the project, then `render` with `action: "export"` and `action: "wait"` until the output is written.

Use `baseRevision` for live imports, saving and export, and `workspaceRevision` for staged operations.
Font imports also reset the client's editing session. `query_project` with `kind: "layers"` or
`"properties"` includes the effective `textStyle` for text layers (`properties` follows the editor
selection); `kind: "fonts"` reads embedded font metadata from either live or staged project snapshots.
`setTextStyle` accepts a nonempty partial style and preserves unspecified fields. For example,
`{ "type": "setTextStyle", "layerId": "title", "textStyle": { "fontFamily": "Georgia" } }`
changes only the family; execute, submit, and commit the workspace as usual. Complete style inputs
remain compatible. Use a CSS-quoted name when a family contains punctuation.
`addProjectFont` and `removeProjectFont` are staged commands; prefer `fonts` with `action: "import"` for files, since
tool request bodies remain capped at 1 MiB. A removed font leaves the requested text family unchanged
and rendering falls back. Embedded fonts are limited to 32 faces and 8 MiB of decoded bytes per project.
Font imports supply a family alias and weight rather than extracting naming or variable-axis tables.
System font lists include family, full name, PostScript name and style; they do not expose file paths.
Concurrent user edits must not be overwritten. After a conflict, call `get_editor_context` with `reset: true` and re-plan
from the new context. Save captures one revision; edits made during persistence remain dirty.
Opening checks the live document again immediately before installing media, the native save path
and editor state in the same synchronous commit. A stale, cancelled or failed load retains the
current document and its media. The returned project revision is zero; read the new context before editing.
Export captures one immutable project/media snapshot. Export destinations must not exist already.
`includeAudio: true` enables audio for MP4; it is false by default.

## Observation and performance limits

- Preview and reference requests accept 1–12 times, with a default maximum edge of 384 pixels and
  an optional `maxDimension` from 64 to 2048. Preview rendering does not upscale a smaller composition.
  Contact sheets accept up to 64 cells of 64–640 pixels (default 320), stay within 4096 pixels per
  edge and 12 MiB of PNG, and label each cell with its (actual, for references) time.
- `crop` uses normalized `x`, `y`, `width`, `height` inside the complete frame. Cropping happens after
  the bounded render/decode; it does not increase source sampling resolution. `layerIds` isolates
  active-composition layers in the cloned preview, preserving the live project.
- Reference selection returns the first frame at or after a requested time, relative to the decoded
  media timeline. For comparisons, `offset` maps composition time to reference time. Aster renders
  at `actualReferenceTime - offset`, avoiding false timing errors on variable-frame-rate sources.
- Comparison requires matching aspect ratios. Both images receive the same normalized crop. RGB
  error compares visible pixels over black and is not a perceptual similarity score. Reference
  FFmpeg RGB conversion and Aster's display output are not an automatic HDR color match.
- Reference audio accepts up to 30 seconds per call. Local reference files are capped at 16 GiB;
  imports retain the existing 96 MiB overall limit and importer-specific limits. Unsupported media
  and empty/out-of-range samples return errors.
- Preview PNGs share an 8 MiB encoding budget; reference PNGs share 12 MiB. Comparison images share
  a 24 MiB base64 budget. Request fewer frames or a smaller size when a budget is exceeded.
- Decoder subprocesses have a 60-second timeout and bounded output. Calls have a 120-second overall
  timeout. Cancellation terminates reference subprocesses and active editing executions, preserving
  earlier staged edits. Disconnect and `get_editor_context` with `reset: true` explicitly discard the client's workspaces.
  An already-started atomic save or durable render enqueue may finish; inspect the saved revision
  or render queue after an interrupted response. Cancelling an export requires `render` with `action: "cancel"`.
- At most eight connected clients and one active tool call are allowed. Concurrent calls receive a
  busy response. `execute_aster_code` and `get_execution` block for up to `wait` milliseconds
  (default 45 000, maximum 60 000, `0` returns the execution ID immediately), so a normal script
  needs one call. Each client may retain four workspaces and run one script at a time.
- The editor may initialize its GPU asynchronously. Agent previews wait up to ten seconds for a
  render session, then report an actionable failure. GPU residency is retained between normal
  editor frames; only requested samples cross to CPU memory.

## Bulk editing and isolated scripts

Both typed commands and scripts use the same staged transaction and explicit submit/commit flow.
A successful commit is one undo step, regardless of operation count. Continue through the same MCP
connection using the returned live revision; restarting the adapter is unnecessary. A revision
conflict preserves the pending workspace for inspection. Resetting explicitly discards it.

| Resource | Limit and accounting |
| --- | --- |
| Typed batch | 256 commands; one candidate copy and one final full-document validation |
| Workspace | 4096 normalized operations across successful executions; a safety fuse, not a session quota |
| Workspace bytes | 32 MiB of serialized operation payloads plus positive document growth relative to the base snapshot; base bytes reported separately |
| Idle lifetime | Staged edits are kept while idle. After 2 hours without activity a workspace becomes evictable, and it is evicted (least recently used first) only when a new workspace needs one of the four slots; status polling does not renew activity; `query_project` kind `workspace` reports `expiresAt` and `remainingMs` |
| Script | 256 KiB of JSON-encoded source; 30-second Worker deadline including startup and validation |
| Guest memory | 32 MiB QuickJS allocator and 64 MiB WebAssembly linear-memory maximum; host project copies are accounted separately |
| Script results | 64 KiB returned JSON per execution |
| Script queries | 1 MiB per in-script query call; not cumulative across a workspace |
| Script modules | 16 modules and 1 MiB per connection; kept across commits and imports, cleared on reset or disconnect |
| Receipts | Last 64 request IDs per client, in memory; last 32 script statuses per editing session |

`query_project` with `kind: "workspace"` reports revision, state, operation/byte usage, limits and expiry.
Errors include `code`, `message` and `details`; budget errors identify the resource, used amount,
limit and recovery suggestion. Counts measure normalized operations, so setting a 3D position costs
three operations; switching a bound composition can add one operation.

Supply a unique `requestId` on `execute_aster_code`,
`submit_workspace`, `discard_workspace` and `commit_workspace` to make retries safe. Retry with the
same ID and identical arguments to receive the original result, including after commit. A reused ID
with different arguments fails. Receipts survive commits but expire on eviction, reset, disconnect,
project replacement or application restart. They are not durable exactly-once guarantees.

Read `describe` with `topic: "script"` once: it is a compact cheat sheet with methods, property paths, expression
functions, text-animator fields, the time-mapping formula, the color convention, budgets and common
errors. `execute_aster_code` accepts a synchronous JavaScript function body with either `workspaceId`
+ `workspaceRevision`, or `baseRevision` to create a workspace. It waits for the execution and
returns `state`, `workspaceRevision`, `result`, `operationCount` and `warnings`; only a result that
still says `running` needs `get_execution`. Only `succeeded` advances the workspace revision.
External clients may pass `commit: true` (and `summary`) to submit and commit a successful,
non-empty execution in the same call; a commit conflict preserves the workspace and reports it.
`get_execution` with `cancel: true` terminates the disposable Worker. Script errors, invalid commands (even when
caught by guest code), cancellation, timeout and resource exhaustion discard only the current
candidate. Previously completed edits remain available. Script and command errors carry the
line and column in the submitted code (or module), the command index and type, and close-match
suggestions for unknown commands, effect types, effect parameters and property paths.

```javascript
const c = aster.compositions.active();
const ids = [];
for (let i = 0; i < 16; i++) {
  const layer = c.layers.addText({
    name: `Unit ${i}`, text: String(i), position: [100 + i * 80, 300, 0],
  });
  layer.opacity.setKeyframes([{ time: 0, value: 0 }, { time: 1, value: 100 }]);
  ids.push(layer.id);
  aster.progress((i + 1) / 16, "Creating units");
}
return { ids };
```

Handles provide composition/layer queries, typed creation, bulk property updates, replacement
keyframe arrays, expressions, effects, duplication and removal. `compositions.find(name)`,
`layers.find(name)` and `list({ namePrefix })` avoid diffing whole lists; `layer.inspect(fields)`
returns only the named dot paths, and every layer inspection includes `sourceRange`.
`composition.precompose(ids, name)` returns `compositionId` and `wrapperLayerId`, and
`aster.command()` returns IDs for created layers, effects, compositions, sources and folders.
`aster.budget()` reports remaining operations and time; `aster.warnings()` lists warnings so far;
`layer.set({ color: '#rrggbb' })` converts hex per layer kind: text colors are display sRGB
(hex/255), while shape, solid and other layer colors are linear light; `aster.color()` and
`aster.linearColor()` return the two forms explicitly. `aster.require(name)` evaluates a stored module once per execution; the
module body receives `module`, `exports` and `aster`. All writes pass through command
normalization; direct object mutation only changes returned JSON copies.

`aster.compositions.remove(ids)` removes compositions in dependency order, and
`aster.compositions.collectUnused({ keep, dryRun, sources })` removes every composition that the
active composition (plus `keep`, by id or name) cannot reach through precomposition layers;
`sources: true` also drops unused footage. `layer.fitToCamera({ margin, cameraId, samples, apply })`
samples the layer's span, projects its rendered quad through the active (or given) camera, and
returns the smallest uniform XY scale multiplier that keeps the frame covered along the whole
camera path; by default it multiplies the static or keyframed X/Y scale.

Expressions (layer properties, effect parameters and text selectors) accept `beat(bpm, offset,
division?)` and `beatphase(bpm, offset, division?)`, which count beats and rise from 0 to 1 within
each beat of a constant-tempo grid, plus `linear(x, a, b, from, to)` and `ease(x, a, b, from, to)`.
Composition markers (`setCompositionMarkers`, `composition.markers()`, `query_project` kind
`markers`) appear on the timeline ruler.

`setEffectParameterExpression` (`layer.setEffectExpression(effectId, parameter, expr)`, or
`layer.property('effects.<effectId>.<parameter>').setExpression(expr)`) drives an effect parameter
with the same expression language, where `value` is the keyframed or static value; use it for
beat-synced glow or time-varying blur without keyframes. Invalid expressions fail the command.

`setTextAnimator` accepts `groups` of selectors (`range`, `expression` with `textIndex`,
`textTotal`, `selectorValue` and `time`, or `wiggly`) and per-character properties (`position`,
`scale`, `rotation`, `opacity`, `blur`, `tracking`, `fillColor`, …). Numbers or animated tracks are
accepted. One text layer can therefore animate a whole lyric line instead of one layer per glyph.

`setLayerTimeMapping.offset` (`layer.setTimeMapping({ sourceStart })`) is the source time shown at
the layer in point: `sourceTime = offset + (compositionTime - inPoint) / stretch`. A mapping that
starts beyond the source duration, or runs past its end, returns a warning in the execution or
batch result, because such a video layer renders its held last frame or nothing.
Text font families are quoted automatically when rasterized, so the name that `fonts` `check`
confirms is the name to pass to `textStyle.fontFamily`. MP4 exports with audio treat video layers
without a decodable audio stream as silence.

Guest JavaScript runs inside QuickJS WASM in a dedicated module Worker. It has no DOM, Electron,
filesystem or network objects, no host module loader and no async job pumping. Returned Promises
are rejected. The document CSP permits WebAssembly compilation (`wasm-unsafe-eval`) but does not
permit renderer JavaScript `eval`. Worker termination is the outer cancellation/time limit even if
the guest stops cooperating. Ordinary typed batches also run in Workers in the editor. Project
snapshot transfer and the final live commit still have CPU cost; the VM memory cap does not bound
all application memory. Preview and export retain the existing GPU renderer and explicit tools.

The existing bounded project command log may retain only a summary for large transactions; undo
uses editor history, not that log. Script text is not stored in project documents. No project format
or native plugin ABI changes are required.

## Validation

Run repository checks through lefthook. `electron/reference-media.test.ts` exercises real reference
decoding when FFmpeg/FFprobe are installed; transport tests check the local request boundary, schemas and
cancellation, and application tests check atomic commits and stale revision protection.

For the packaged Windows application:

```powershell
pnpm artifact:build --dir --win --x64 --publish never
node scripts/automation-smoke.mjs
node scripts/automation-smoke.mjs release/win-unpacked/Aster.exe --background
```

To include system-font enumeration, embedded font import, partial style updates and font export in
the packaged smoke workflow, set `ASTER_SMOKE_FONT` to an absolute TTF/OTF/WOFF/WOFF2 file path before
running the script. The test imports it under a unique project alias and verifies the saved bytes;
it never installs the font into the OS.

The smoke test starts a separate profile, connects through MCP, creates animation, renders full and
cropped frames, compares a generated audiovisual reference, imports it, saves a project, and exports
an MP4 with audio. Reports and sampled PNGs remain under `artifacts/automation-smoke-<timestamp>`.
The test terminates only the application process tree it launched.

Run the two-phase editing integration test against a fresh build:

```powershell
pnpm build
node scripts/automation-edit-smoke.mjs
```

It launches a private hidden Electron editor through MCP and verifies Worker/WASM startup under
the production CSP, bulk scripting, rollback, responsiveness during an infinite loop, cancellation,
the hard deadline, GPU preview, retry-safe commit, capability discovery, script modules, text
animators, the `commit: true` shortcut and `render` `wait` for a still export. Reports are saved under `artifacts/automation-edit-*`.

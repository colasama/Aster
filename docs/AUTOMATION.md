# External automation and video reconstruction

Aster 0.3.1 exposes the running desktop editor to external agents through an MCP stdio adapter.
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

| Tools | Behavior |
| --- | --- |
| `get_editor_context`, `reset_session` | Read the live revision and composition; reset discards this client's staged work and captures the current editor. |
| `search_capabilities`, `get_command_schemas`, `query_project` | Discover exact command schemas and read bounded project slices. |
| `begin_edit_workspace`, `execute_commands`, `evaluate_at_time` | Stage validated commands and evaluate at explicit times. |
| `render_preview`, `analyze_render`, `inspect_diagnostics` | Render staged frames and inspect objective diagnostics. |
| `submit_workspace`, `commit_workspace`, `discard_workspace` | Submit a diff, explicitly merge it as one undoable edit, or discard it. A changed live revision blocks commit. |
| `probe_reference` | Return FFprobe stream/format metadata for an absolute local media path. |
| `read_reference_frames` | Return PNG frames, requested times and actual decoded timestamps. |
| `read_reference_audio` | Return a bounded mono 16 kHz PCM WAV excerpt as native MCP audio content. |
| `compare_reference` | Return reference/render pairs, 50% overlays, absolute difference images and normalized RGB error. |
| `import_asset` | Import image, video, audio, SVG, PSD composition or embedded glTF/GLB into the live active composition as one undoable edit. |
| `list_fonts` | List system faces and embedded project fonts, filtered by `source` (`all`, `system`, `project`) and `query`, with `offset`/`limit` pagination (maximum 128). Returns metadata, never font bytes. |
| `check_fonts` | Check 1–64 exact family names against project fonts and Chromium's system inventory. If inventory access fails, explicitly report heuristic `fallback-metrics` results. No glyph-coverage or resolved-fallback guarantee. |
| `import_font` | Embed a local TTF/OTF/WOFF/WOFF2 font face with an explicit `family` alias and optional `weight` (default 400), at `baseRevision`. Decode before committing one undoable edit. Project-only; no OS installation. |
| `save_project` | Save an exact project revision and collect media into an absolute bundle directory. Replacing an existing `project.json` requires `overwrite: true`. |
| `open_project` | Open an absolute native bundle directory at `baseRevision` without a file dialog. Loads fonts and media, resets the editor history and invalidates all automation workspaces. Save unsaved edits first. Packed `.aster` files must be unpacked first. |
| `export_render`, `get_render_queue`, `cancel_render` | Queue an immutable MP4, PNG sequence or still snapshot, inspect progress/errors and cancel a job. |

Images and audio are returned as native MCP content blocks. Text metadata identifies content indices
without duplicating base64 data. Reference tools are external automation tools; the built-in Pi
panel retains its existing tool and grant surface, with the additional preview options shared by
both adapters.

## Reconstruction loop

1. Probe the reference, sample meaningful times, and read short audio excerpts when timing matters.
2. Reset the session, read the live revision, and begin a workspace at that revision.
3. Discover schemas and execute small batches to build compositions, layers, effects and keyframes.
4. Render or compare at explicit times. Adjust the staged parameters and repeat.
5. Submit and commit the exact workspace revision. Import required media using the returned live
   revision; imports reset this client's edit session. Start another workspace for further edits.
6. Save the project, enqueue export, and inspect the queue until completion or failure.

Use `baseRevision` for live imports, saving and export, and `workspaceRevision` for staged operations.
Font imports also reset the client's editing session. `query_project` with `kind: "layers"` or
`"properties"` includes the effective `textStyle` for text layers (`properties` follows the editor
selection); `kind: "fonts"` reads embedded font metadata from either live or staged project snapshots.
`setTextStyle` accepts a nonempty partial style and preserves unspecified fields. For example,
`{ "type": "setTextStyle", "layerId": "title", "textStyle": { "fontFamily": "Georgia" } }`
changes only the family; execute, submit, and commit the workspace as usual. Complete style inputs
remain compatible. Use a CSS-quoted name when a family contains punctuation.
`addProjectFont` and `removeProjectFont` are staged commands; prefer `import_font` for files, since
tool request bodies remain capped at 1 MiB. A removed font leaves the requested text family unchanged
and rendering falls back. Embedded fonts are limited to 32 faces and 8 MiB of decoded bytes per project.
Font imports supply a family alias and weight rather than extracting naming or variable-axis tables.
System font lists include family, full name, PostScript name and style; they do not expose file paths.
Concurrent user edits must not be overwritten. After a conflict, call `reset_session` and re-plan
from the new context. Save captures one revision; edits made during persistence remain dirty.
Opening checks the live document again immediately before installing media, the native save path
and editor state in the same synchronous commit. A stale, cancelled or failed load retains the
current document and its media. The returned project revision is zero; read the new context before editing.
Export captures one immutable project/media snapshot. Export destinations must not exist already.
`includeAudio: true` enables audio for MP4; it is false by default.

## Observation and performance limits

- Preview and reference requests accept 1–12 times, with a default maximum edge of 384 pixels and
  an optional `maxDimension` from 64 to 2048. Preview rendering does not upscale a smaller composition.
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
  timeout. Cancellation terminates reference subprocesses and discards the client's staged work.
  An already-started atomic save or durable render enqueue may finish; inspect the saved revision
  or render queue after an interrupted response. Cancelling an export requires `cancel_render`.
- At most eight connected clients and one active tool call are allowed. Concurrent calls receive a
  busy response. Each workspace retains the existing 128-command, 16 MiB and ten-minute limits.
- The editor may initialize its GPU asynchronously. Agent previews wait up to ten seconds for a
  render session, then report an actionable failure. GPU residency is retained between normal
  editor frames; only requested samples cross to CPU memory.

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

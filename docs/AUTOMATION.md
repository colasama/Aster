# External automation and video reconstruction

Aster 0.2.1 exposes the running desktop editor to external agents through an MCP stdio adapter.
The adapter reuses the same command definitions and staged application service as the built-in Pi
agent. Reference decoding uses FFmpeg/FFprobe; imports, persistence and rendering use existing Aster
services. No model credentials are needed to operate these tools.

## Start a local connection

Open **Preferences → MCP** in the desktop application and enable MCP. The switch applies immediately
and its state persists across restarts. The section also provides a port field with an **Apply port**
action, token generation/rotation, token copy, and **Copy client configuration**. Copying configuration
includes the correct executable and adapter paths for the current installation. The editor must remain
running. Rotating the token disconnects existing clients; copy the new configuration into the client.
Closing Preferences does not undo MCP changes; these controls apply independently of other preferences.

The status shows whether the listener is running, the number of retained client sessions, and whether
a tool call is active. A port conflict leaves the previous working listener in place. Startup errors
are shown here without preventing the editor from opening.

Settings are stored in `automation.json` in the application profile. Tokens use Electron `safeStorage`
encryption backed by the operating system and are never sent to renderer state or included in diagnostic
preferences. Secure credential storage must be available; there is no plaintext storage fallback.
The initial state is disabled, and enabling MCP generates a token automatically.

For environment-managed sessions, set `ASTER_AUTOMATION_TOKEN` before starting Aster.
Environment settings take precedence and the UI controls become read-only;
configuration and token copy remain available. Set a random
secret of at least 32 characters and optionally `ASTER_AUTOMATION_PORT` (default `48765`). Start Aster
with those environment variables. Close an existing instance first, or use a separate
`--user-data-dir` for an isolated project session.

For a source checkout, build once with `pnpm build`, start the desktop application with `pnpm dev`,
and configure the MCP client to launch:

```json
{
  "mcpServers": {
    "aster": {
      "command": "node",
      "args": ["E:/code/Aster/dist-electron/electron/automation-mcp.js"],
      "env": {
        "ASTER_AUTOMATION_TOKEN": "<same secret used to start Aster>",
        "ASTER_AUTOMATION_PORT": "48765"
      }
    }
  }
}
```

Adjust paths for your checkout. `pnpm mcp` runs the same adapter. The desktop application must be
running; starting the adapter alone does not start the editor.

For an installed Windows package, a separate Node installation is unnecessary. Use the installed
`Aster.exe` as the MCP command, pass
`<installation>/resources/app.asar/dist-electron/electron/automation-mcp.js` as its only argument,
and add `ELECTRON_RUN_AS_NODE=1` to **the adapter's environment only**. Do not set that variable for
the interactive Aster application. FFmpeg and FFprobe are bundled in `resources/bin`.

The adapter uses the official MCP SDK and its
[stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#stdio).
Only protocol messages are written to adapter stdout; errors go to stderr. The adapter communicates
with a private authenticated HTTP bridge bound exclusively to `127.0.0.1`. This bridge is not an
MCP HTTP endpoint. It rejects browser Origin headers and unexpected Host headers. Never place the
token in project files, source control, logs or a public endpoint. Enabling this local session grants
holders of the token access to the listed editing and local media/file tools; it does not grant
arbitrary shell, network or plugin installation access.

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
| `check_fonts` | Infer availability of named families from browser fallback metrics; this is not an installed font-file inventory. |
| `save_project` | Save an exact project revision and collect media into an absolute bundle directory. Replacing an existing `project.json` requires `overwrite: true`. |
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
Concurrent user edits must not be overwritten. After a conflict, call `reset_session` and re-plan
from the new context. Save captures one revision; edits made during persistence remain dirty.
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
decoding when FFmpeg/FFprobe are installed; transport tests check authentication, schemas and
cancellation, and application tests check atomic commits and stale revision protection.

For the packaged Windows application:

```powershell
pnpm artifact:build --dir --win --x64 --publish never
node scripts/automation-smoke.mjs
```

The smoke test starts a separate profile, connects through MCP, creates animation, renders full and
cropped frames, compares a generated audiovisual reference, imports it, saves a project, and exports
an MP4 with audio. Reports and sampled PNGs remain under `artifacts/automation-smoke-<timestamp>`.
The test terminates only the application process tree it launched.

The initial 0.2.1 Windows x64 artifact passed this packaged MCP workflow on 2026-09-07, including a
320 × 180, ten-frame H.264 export with a one-second AAC track. The exported frame was also inspected
visually. Repository validation passed Biome, TypeScript, 1,305 frontend tests (one skipped), five
packaging checks, Rust formatting, Clippy with warnings denied, and workspace Rust tests. This is a
functional smoke check, not a throughput benchmark or a guarantee of visual reconstruction quality.

The settings update passed 1,311 frontend tests (one skipped) and all five packaging checks. Packaged
Windows UI validation covered enabling MCP, applying a port, copying client configuration, encrypted
persistence, restoring the listener after a normal application restart, and disabling it. The updated
artifact also passed the complete audiovisual MCP smoke workflow again.

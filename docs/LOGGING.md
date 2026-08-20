# Logging and Diagnostics

Aster uses one structured application log across the sandboxed renderer, Electron main process, and
Rust desktop bridge. The Electron main process owns persistence so neither the renderer nor the
bridge receives direct access to the log directory.

## Storage and retention

The active log is `logs/aster.jsonl` below Electron's `userData` directory. On Windows this is
typically `%APPDATA%/Aster/logs/aster.jsonl`; the exact directory is recorded by the
`application.started` entry. Each file is capped at 5 MiB. Aster retains the active file and four
numbered archives (`aster.1.jsonl` through `aster.4.jsonl`), removing the oldest archive during
rotation.

File writes are queued asynchronously. Logging must never block rendering, GPU submission, project
I/O, or IPC responses. High-frequency frame transport and hot-reload polling are deliberately not
logged on success; their failures are still recorded.

## Levels and configuration

Development builds default to `debug`; packaged builds default to `info`. Set `ASTER_LOG` before
starting Aster to one of `debug`, `info`, `warn`, or `error` to override the default. The same value
is passed to the Rust bridge's `tracing` filter.

Use levels consistently:

- `debug`: lifecycle details, bounded IPC timing, and initialization decisions.
- `info`: successful user-visible milestones such as project load/save, renderer readiness, and
  export completion.
- `warn`: recoverable degradation, rejected input, fallback behavior, and failed commands.
- `error`: lost processes/devices, failed exports, and uncaught errors.

## Entry schema

Every line is an independent JSON object:

```json
{
  "timestamp": "2026-08-21T10:15:30.000Z",
  "sequence": 42,
  "sessionId": "f17b2eb1-2ce4-4a91-a0bf-54a24fe38117",
  "process": "renderer",
  "level": "info",
  "scope": "webgpu",
  "event": "initialized",
  "data": { "timestampQueries": true, "prewarmedPipelines": 24 }
}
```

`sessionId` correlates all three processes. `sequence` is the Electron ingestion order, not a frame
number. Rust records preserve their original timestamp in `data.bridgeTimestamp` after ingestion.
Use stable snake-case event names and bounded structured fields instead of embedding values in the
event name.

## Security and privacy

The bridge command logger records command names, request IDs, outcomes, and durations; it never
records command arguments, project documents, frame pixels, AI prompts, or asset contents. Keys that
look like passwords, API keys, authorization values, secrets, or tokens are replaced with
`[REDACTED]`. Collections, strings, nesting depth, and renderer-provided labels are bounded before
writing.

Logs can still contain local file paths and error messages needed for diagnosis. Treat a shared log
bundle as potentially sensitive and inspect it before publishing.

## Adding events

Renderer code should use `src/core/logger.ts`, Electron code should use the process-wide
`AsterLogger`, and Rust bridge code should use `tracing` macros. Do not restore direct
`console.warn`, `console.error`, `println!`, or `eprintln!` calls in application paths. CLI examples
and golden-image test output may continue to write to their terminal.

Do not log inside per-frame render loops, pixel/frame IPC, or other hot paths. Prefer one event when
an operation begins, one when it completes with `durationMs`, and one on failure. Repeated fallback
warnings must be latched until the condition recovers.

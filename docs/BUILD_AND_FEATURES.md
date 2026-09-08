# Desktop Builds and Feature Flags

## Supported artifact workflow

The `Build desktop artifacts` GitHub Actions workflow runs for version tags (`v*`) and manual
dispatches. Artifacts are not published automatically. Each run first executes the complete quality
gate, then builds the platform bundles in parallel:

| Runner | Target | Bundles |
| --- | --- | --- |
| Ubuntu 22.04 | Linux x64 | AppImage and Debian package |
| Windows | Windows x64 | NSIS installer |
| macOS 14 | Universal Apple binary | DMG and ZIP |

Node/pnpm downloads use the pnpm store cache. Electron downloads, Rust dependencies, and build
outputs use separate
cache per operating system, preventing incompatible native objects from being restored across
platforms. Uploaded bundles are retained for 14 days and contain the commit SHA in their artifact
name. Code signing and notarization are intentionally outside this MVP workflow; release promotion
must add platform secrets and a separate publishing job rather than granting write permissions to
ordinary artifact builds.

Build a production artifact locally with:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm artifact:build
```

To choose only platform-appropriate bundles, use the same command shape as CI:

```bash
pnpm artifact:build -- --linux AppImage deb --x64
```

Use `--win nsis --x64` on Windows. The universal macOS CI job builds the bridge for both Apple
architectures, combines it with `lipo`, and then runs `electron-builder --mac --universal` so the
sidecar architecture always matches the bundled Electron runtime.

## MP4 encoder dependency

The MP4 path launches an FFmpeg executable from Electron's main process. Development resolves
`ASTER_FFMPEG_PATH` first and otherwise uses `ffmpeg`/`ffmpeg.exe` from `PATH`. `pnpm artifact:build`
validates that executable, copies it into the ignored `build/ffmpeg` staging directory, records its
source/version, and packages it as `resources/bin/ffmpeg` (or `ffmpeg.exe`). Packaged applications
always prefer that controlled copy before applying the development fallback.

Artifact producers remain responsible for the selected FFmpeg distribution and its licenses. Release
automation must use a reproducible platform-specific `ASTER_FFMPEG_PATH`, publish its configuration
and licenses, verify NVENC and software fallback probes, and pass the codec/legal gates in
`MEDIA_BACKENDS.md`. Missing or non-executable FFmpeg fails artifact preparation and produces an
actionable export error at runtime; MP4 jobs never silently fall back to PNG.

## MVP feature-flag policy

Aster ships one product configuration during the MVP. GPU-first rendering, AI operation planning,
and native WGSL plugins are core product behavior, not optional editions. Keeping them in one tested
configuration avoids a combinatorial build matrix and prevents partially working releases.

The Electron shell and `aster-desktop-bridge` currently define no product feature flags. Development
and packaged builds use the same command surface; packaging changes only asset locations and the
Electron loading URL. CI still runs Clippy and tests with `--all-features`, so any crate-local
features remain covered before bundling.

New flags must meet all of these requirements:

1. They remove a meaningful dependency, enforce a security boundary, or select platform code that
   cannot be chosen at runtime.
2. Both enabled and disabled states have automated coverage, or the flag becomes part of the sole
   production configuration.
3. They do not preserve legacy project schemas. The MVP project format is allowed to break, and old
   documents are rejected instead of selecting compatibility code through a feature flag.
4. They are declared at the narrowest owning crate and propagated explicitly by the desktop crate.
5. They are documented here and included in the artifact workflow when they affect shipped builds.

Experiments that do not change dependencies or security boundaries should use typed runtime
settings with a safe default. Incomplete functionality stays off the main branch instead of being
hidden behind long-lived boolean environment variables. This keeps production behavior observable,
testable, and easy to remove after the MVP stabilizes.

## 0.2.1 automation artifacts

Artifact preparation now validates and stages both FFmpeg and FFprobe. `ASTER_FFPROBE_PATH` overrides
the probe executable; otherwise preparation searches beside FFmpeg and then PATH. Their provenance
is recorded in `build/ffmpeg/ffmpeg-source.json`. Packaged reference tools use `resources/bin`.
The MCP stdio adapter is compiled into `dist-electron/electron/automation-mcp.js`; see
[External Automation](AUTOMATION.md) for source and installed-client launch configuration.

The desktop bridge crate also builds `aster-mcp` (`aster-mcp.exe` on Windows), packaged in
`resources/bin`. This small native launcher runs the bundled Electron executable in Node mode
with the adapter script, preserving stdio on Windows without launching a console window from
the MCP client. `--background` starts a hidden editor with a temporary profile and dynamic port.
The adapter and editor use a dedicated parent IPC channel for readiness and shutdown; neither
mode requires a token. `pnpm mcp --background` uses the installed development Electron runtime
and previously built production assets.

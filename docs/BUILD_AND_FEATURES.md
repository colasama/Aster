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

The MVP MP4 path launches an FFmpeg executable from Electron's main process. Development resolves
`ASTER_FFMPEG_PATH` first and otherwise uses `ffmpeg`/`ffmpeg.exe` from `PATH`. A packaged build first
looks for `resources/bin/ffmpeg` (or `ffmpeg.exe`), then applies the same development fallback.

The artifact workflow does not yet bundle FFmpeg. A release that advertises MP4 export must add a
reproducible, platform-specific FFmpeg artifact under `resources/bin`, publish its configuration and
licenses, verify NVENC and software fallback probes, and pass the codec/legal gates in
`MEDIA_BACKENDS.md`. Missing FFmpeg produces an actionable export error and never falls back to PNG
intermediates.

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

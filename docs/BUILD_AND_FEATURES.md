# Desktop Builds and Feature Flags

## Supported artifact workflow

The `Build desktop artifacts` GitHub Actions workflow runs for version tags (`v*`) and manual
dispatches. Artifacts are not published automatically. Each run first executes the complete quality
gate, then builds the platform bundles in parallel:

| Runner | Target | Bundles |
| --- | --- | --- |
| Ubuntu 22.04 | Linux x64 | AppImage and Debian package |
| Windows | Windows x64 | NSIS installer |
| macOS 15 | Universal Apple binary | DMG and ZIP |

Node/pnpm downloads use the pnpm store cache. Rust dependencies and build outputs use a cache per
operating system. FFmpeg downloads use a separate cache keyed by the pinned asset manifest; cached
bytes are checked against SHA-256 before use. Uploaded installers and `SHA256SUMS.txt` are retained
for 14 days and contain the commit SHA in their artifact name. Unpacked application directories are
not uploaded. Developer ID signing and notarization remain outside this preview workflow. macOS
tools and the final app receive ad-hoc signatures after merging; these do not establish a trusted
publisher identity. Hardened runtime is disabled for this certificate-free preview build.
Publishing is explicitly disabled, including on version tags.

To build from a Windows machine without configuring a macOS cross-toolchain:

1. Commit and push the desired source and workflow to GitHub. The workflow must also exist on the
   default branch for the manual trigger to appear.
2. Open **Actions → Build desktop artifacts → Run workflow**, select the branch, and run it.
3. After the quality gate and platform bundles succeed, download `aster-macos-universal-<sha>` from
   the run's **Artifacts** section. It contains the DMG, ZIP, and checksums. Both Mac architectures
   are included; a local Mac, signing certificate, and GitHub release are not required.

The quality job invokes the repository's lefthook checks and `cargo deny check`. Rust CI requires
no system WebKit/GTK development packages: the desktop shell uses Electron. GPU golden-image helpers
compile only with their Windows adapter tests; the CPU fixture test runs on every platform.

`deny.toml` temporarily accepts the maintenance-only advisory `RUSTSEC-2024-0436` for the build-time
`paste` macro dependency (`exr 1.74.2 -> pulp 0.22.3`). These compatible published releases have no
replacement yet. Remove the exception when EXR adopts a published Pulp version using `pastey`;
other advisories, yanked versions, licenses, and sources remain checked.

Bundle jobs download their own pinned
media tools, compile the app, package it, then run the installed sidecars and a real H.264/AAC encode
and FFprobe check before upload. The macOS job also verifies both architecture slices and rejects
non-system dylib dependencies in the four bundled tools. The smoke check runs on the host
architecture; it does not replace GUI/GPU testing on both Intel and Apple Silicon hardware.

Build a local artifact using FFmpeg and FFprobe already available on PATH (or explicit
`ASTER_FFMPEG_PATH` / `ASTER_FFPROBE_PATH` paths):

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm artifact:build
```

To choose only platform-appropriate bundles:

```bash
pnpm artifact:build -- --linux AppImage deb --x64
```

Use `--win nsis --x64` on Windows, or `--mac dmg zip --arm64` on an Apple Silicon Mac. Local builds
must use media tools and a Rust host toolchain matching the selected architecture. To use the same
pinned media tools as CI for a native build, run these commands instead:

```bash
pnpm install --frozen-lockfile
pnpm artifact:download-ffmpeg
pnpm build
pnpm exec electron-builder --config scripts/electron-builder.ts --publish never
```

Do not run `artifact:prepare-ffmpeg` or `artifact:build` after downloading the pinned tools: those
commands intentionally restage the user's PATH/override binaries. The universal macOS CI job uses
`pnpm artifact:download-ffmpeg --universal`, builds the two Rust executables for both Apple
architectures, combines each with `lipo`, and packages with `--mac dmg zip --universal`.

The About dialog and packaged application version include the current Git commit's short hash,
for example `0.2.1+29ead88`. The same version appears in installer filenames, application logs,
and diagnostic exports. `scripts/electron-builder.ts` supplies this version to Vite and the
packager without modifying the source package version. Native numeric build versions retain the
public version for platform compatibility. Builds require a Git checkout and read its current HEAD;
uncommitted changes are included in the build but are not represented by the hash.

## MP4 encoder dependency

The MP4 path launches an FFmpeg executable from Electron's main process. Development resolves
`ASTER_FFMPEG_PATH` first and otherwise uses `ffmpeg`/`ffmpeg.exe` from `PATH`. `pnpm artifact:build`
validates that executable, copies it into the ignored `build/ffmpeg` staging directory, records its
source/version, and packages it as `resources/bin/ffmpeg` (or `ffmpeg.exe`). Packaged applications
always prefer that controlled copy before applying the development fallback.

CI uses `scripts/ffmpeg-downloads.json` to pin individual compressed binaries, license text, and build
information. Windows/Linux use the `eugeneware/ffmpeg-static` `b6.1.1` release; macOS uses Martin Riedl's
dated 9.0.2 builds for Intel and Apple Silicon. Asset hashes are the immutable identity. The downloader
rejects binaries configured with `--enable-nonfree` before staging either architecture.
`ffmpeg-source.json` records the actual version and full build configuration reported by both tools.
`ffmpeg-download.json` records the upstream URL, asset hashes, and explicit `gpl-preview` flavor.
These manifests and upstream notices are shipped beside the executables. The macOS downloads are
merged into universal executables, so neither Homebrew libraries nor Rosetta are needed for the
bundled media tools. No new npm dependency is required.

The preview flavor includes GPL-enabled FFmpeg with `libx264`, which the current software export
fallback requires. It is separate from the planned LGPL-only stable distribution policy and is not
approval for a stable release. Release promotion still requires the source/license and codec review
described in `MEDIA_BACKENDS.md`. Hosted runners validate software export; NVENC remains a runtime
probe and requires a suitable GPU/driver for hardware validation.

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

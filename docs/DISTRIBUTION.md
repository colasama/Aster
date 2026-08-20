# Distribution and trust policy

## Desktop packages

The artifact workflow builds Aster from the same quality-gated commit on every supported desktop
runner. Windows produces MSI and NSIS installers, macOS produces a universal application and DMG,
and Linux produces AppImage and Debian packages. Artifact builds are unsigned previews until a
release job supplies platform signing identities; unsigned artifacts must never be promoted as a
stable release.

Windows preview installers embed the WebView2 offline installer so a clean machine can install
without network access. The stable application identifier is `io.github.aster-mograph.aster`; it
must not change after public release because it defines upgrade identity and application data paths.

## Auto-update strategy

Auto-update remains disabled for the MVP. Enabling it requires all of the following in one change:

1. Tauri updater signatures verified against a public key compiled into the application.
2. HTTPS release metadata containing version, platform, architecture, digest, signature, and size.
3. An explicit user setting with `Notify only` as the default; downloads never run while rendering.
4. Atomic installation with the previous version retained for one-start rollback.
5. A staged channel that proves schema compatibility, startup recovery, and GPU backend smoke tests
   before stable metadata is updated.

The updater may replace application binaries only. It never rewrites project files, plugins, caches,
or preferences. Because the MVP has no legacy project migration, release notes must call out project
schema changes before users save with a new build.

## Crash reporting opt-in

Crash reporting is off by default and must remain a separate consent from analytics or updates. A
future crash prompt shows the exact envelope before transmission. The default envelope contains the
Aster version, OS, GPU adapter/backend, fault module, bounded stack trace, and an anonymous random
installation ID. It excludes project names, paths, media, timeline values, provider prompts, API
keys, plugin contents, and memory dumps. Users can copy or save the report locally without sending.

Reports are size bounded, scrubbed for path and credential patterns, sent over HTTPS, and retained
for a documented period. Consent can be revoked from Preferences, and repeated crashes must not
create a restart/upload loop. Local autosave recovery works independently of reporting.

## Plugin signature and trust model

Plugin v1 remains WGSL-only: installation copies the declared manifest and shader after path, size,
WGSL, ABI, and parameter validation. Native libraries and undeclared files are not trusted payloads.
The future registry signature envelope uses an Ed25519 signature over a canonical manifest plus a
SHA-256 digest for every declared file. Registry publisher keys are distinct from Aster release keys.

Locally installed unsigned plugins remain possible for development but are visibly marked untrusted,
never auto-updated, and can be disabled together through Safe Mode. A signed update cannot change
publisher identity or request new capabilities without renewed user approval. Revocation metadata is
cached with an expiry and cannot silently delete a locally installed plugin.

## Stability criteria

Plugin API v1 is stable only after:

- WGSL bindings, parameter packing, texture semantics, capability names, and error behavior have
  conformance fixtures on every supported GPU backend;
- unknown manifest fields and unsupported API versions fail closed;
- at least two independently authored example effects survive three patch releases unchanged; and
- resource quotas, device-loss behavior, and signature verification are implemented.

Project Spec v1 is stable only after:

- the JSON schema and canonical examples cover every persisted field;
- atomic save/recovery, relative assets, missing plugins/assets, and maximum-size bounds pass on all
  desktop platforms;
- packed projects define deterministic paths, checksums, and extraction limits; and
- a compatibility policy replaces the MVP's current-schema-only gate.

Aster follows semantic versioning for public artifacts. Patch releases preserve stable schemas and
ABIs, minor releases may add optional fields/capabilities, and a major release may remove or reinterpret
them. Before either v1 contract is declared stable, `0.x` releases may break it and must state that in
release notes. GPU output fixes that materially change rendered pixels require a highlighted note and
updated golden references even when the serialized format is unchanged.

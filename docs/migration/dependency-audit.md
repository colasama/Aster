# Renderer comparison dependency audit

## Native font catalog dependencies

Glyph rasterization adds Skrifa 0.48.0, Zeno 0.3.3 and PNG 0.18.1, all MIT OR Apache-2.0.
PNG adds `fdeflate` 0.3.7 under the same license and reuses the locked compression packages.
The graph adds exactly four packages and changes no existing version. Skrifa reuses `read-fonts`
0.45.1 instead of introducing a second font parser version. Outline interpretation, hinting,
coverage rasterization and checked PNG decoding are complex maintenance/security boundaries that
remain behind Aster-owned limits and typed interfaces. No native C/C++ dependency is added.
`cargo deny check` passes advisories, bans, licenses and sources; see
`artifacts/migration/cycle123-cargo-deny.log`. This component increment is not a release.

Swash 0.2.10 was reviewed but not added: its current Skrifa range would introduce an older parser
graph, and its high-level image renderer allocates before Aster can enforce exact raster bounds.
Direct Skrifa outline emission and Zeno sizing allow bounded command collection, scratch and image
allocation before publication. The maintained APIs are documented in
[Skrifa](https://docs.rs/skrifa/0.48.0/skrifa/), [Zeno](https://docs.rs/zeno/0.3.3/zeno/) and
[PNG](https://docs.rs/png/0.18.1/png/).

Native shaping adds HarfRust 0.14.0 (MIT), the maintained pure-Rust HarfBuzz port, and reuses the
already locked `read-fonts` 0.45.1 parser. ICU4X `icu_segmenter` and `icu_segmenter_data` 2.3.0
(Unicode-3.0) supply word and grapheme segmentation; `core_maths` 0.1.1 (MIT OR Apache-2.0)
reuses the existing `libm`. The lockfile adds exactly these four packages and changes no existing
package version. No native C/C++ library or project-format change is introduced. HarfRust forbids
unsafe code and exposes an allocation/operation-success flag that Aster checks in addition to the
shaping result. Input bounds also limit its internal expansion and operation budgets.
`cargo deny check` passes advisories, bans, licenses and sources; evidence is retained in
`artifacts/migration/cycle122-cargo-deny.log`. The previously recorded unavailable `cargo audit`
command remains a release-audit limitation. This component increment is not a release.

The native font catalog adds `read-fonts` 0.45.1 and its `font-types` 0.12.7 dependency
(MIT OR Apache-2.0), maintained in Google's Fontations project. Table parsing stays behind
`aster-text` interfaces and bounds face counts, resident bytes, family names and variation axes.
Using a maintained checked parser avoids implementing another OpenType binary parser. The catalog
does not yet establish shaping, glyph coverage, rasterization or production text parity.

`icu_casemap` 2.3.0 and `icu_casemap_data` 2.3.0 (Unicode-3.0) provide Unicode default case
folding for family matching without normalization or locale tailoring. Lowercasing alone does not
implement this behavior. Both dependencies are pure Rust. Their MSRVs (1.85 for `read-fonts`,
1.88 for `icu_casemap`) are below the workspace's Rust 1.97 requirement. The reviewed Cargo lockfile
adds these four packages, enables `serde` on the existing `potential_utf` dependency, and changes
no existing package version. No native library, plugin ABI or project format changes are required.

The 2026-10-20 audit passes `cargo deny check` for advisories, bans, licenses and sources
(`artifacts/migration/cycle119-cargo-deny.log`). `cargo audit` is unavailable in this environment;
its failed invocation is retained in `cycle119-cargo-audit.log` and is not counted as a passing
release audit. This increment is not a release.

The same audit found four newly reported advisories in the existing JavaScript graph. Scoped
overrides update Hono 4.13.7 to 4.13.11 under MCP SDK 1.32.1 and `follow-redirects` 1.16.0 to
1.16.1 under Axios 1.20.0. Vite is pinned to 8.2.4 from 8.2.1 to apply its Windows launch-editor
fix without selecting a newer minor release. No other installed package versions change.
The original audit is retained at `artifacts/migration/cycle119-pnpm-audit.json`; the final
`cycle119-pnpm-audit-patched.json` reports zero advisories across 527 dependencies. Installation
used `--ignore-scripts`; Electron and the shipped FFmpeg build remain unchanged. These overrides
can be removed when their direct parents require the patched versions themselves.

Embedded font resolution reuses the locked `base64` 0.22.1 and `flate2` 1.1.9 packages; no new
third-party package is added. The small WOFF1 container adapter validates directory arithmetic,
non-overlapping contiguous blocks and padding before allocating a bounded SFNT, requires exact
zlib stream consumption/output size, and verifies table checksums before rebuilding the overall
checksum. Font table interpretation remains in `read-fonts`.

Wuff 0.2.9 (MIT, pure Rust) was evaluated for WOFF/WOFF2 but was not added. Its WOFF1 decoder
leaves checksum adjustment unfinished, and its WOFF2 final reconstructed-size check occurs after
reconstruction; a declared header size alone cannot establish Aster's allocation bound. The native
resolver therefore identifies WOFF2 explicitly for the existing retained raster provider, which
must still validate and decode it. This is a capability boundary, not native WOFF2 acceptance.

The new CPU comparison crate uses RustFFT 6.4.1 (MIT OR Apache-2.0) for its phase-correlation FFT.
Its maintained, SIMD-capable, pure-Rust implementation avoids maintaining a second numerical FFT
and introduces no native C/C++ library or GPU/vendor dependency. The lockfile adds RustFFT,
num-integer 0.1.47, primal-check 0.3.4, strength_reduce 0.2.4 and transpose 0.2.3; num-complex and
num-traits were already present. PNG encoding reuses the existing locked crc32fast and flate2.

`cargo deny check` passes advisories, bans, licenses and sources; `cargo audit` finds no vulnerable
packages. Evidence is retained in `artifacts/migration/cycle4-cargo-deny.log` and
`artifacts/migration/cycle4-cargo-audit.log`. The pre-existing unmaintained `paste` warning and its
documented exr/pulp exception remain; the comparison dependencies add no exception. This is a
development verification increment, not a release or a change to the shipped FFmpeg build.

The comparison work exposed an existing JavaScript dependency audit failure on 2026-10-03 UTC:
54 advisories (31 high, 19 moderate, 4 low). The original report is retained at
`artifacts/migration/cycle4-pnpm-audit-before.json`. No advisory or severity is excluded from the
audit. The final report, `artifacts/migration/cycle4-pnpm-audit-after.json`, contains zero advisories
across 527 dependencies. The intermediate report records the one unresolved advisory before the
download dependency chain was replaced.

## Version changes

`pnpm-workspace.yaml` scopes overrides to the installed parent package and version. Transitive
packages remain in their existing major release lines, except for the development-only Electron
artifact downloader described below. The runtime `ip-address` change is a patch release used by
the MCP SDK's rate limiter. Application dependencies otherwise retain their locked versions.

| Package | Previous | Selected |
| --- | --- | --- |
| Electron | 43.4.1 | 43.5.0 |
| `@xmldom/xmldom` | 0.8.14 | 0.8.15 |
| axios | 1.19.0 | 1.20.0 |
| brace-expansion | 1.1.18 / 2.1.4 / 5.0.9 | 1.1.21 / 2.1.7 / 5.0.12 |
| fast-uri | 3.1.5 | 3.1.8 |
| ip-address | 10.7.0 | 10.7.1 |
| joi | 18.2.5 | 18.2.6 |
| js-yaml | 4.3.1 | 4.3.2 |
| undici | 6.28.0 / 7.29.0 | 6.28.1 / 7.29.1 |
| `app-builder-lib`'s `@electron/get` | 3.1.0 | 5.1.0 |

Electron's [sandboxed preload cache advisory](https://github.com/advisories/GHSA-qmv3-fv6v-rmhq)
requires a patched Electron release. The selected version stays on the existing major release line.
Its installer was run explicitly after installing the dependency graph without lifecycle scripts;
`pnpm exec electron --version` confirmed `v43.5.0`. FFmpeg and other native dependencies were not
replaced or downloaded by this change.

## Artifact downloader compatibility

The remaining [http-cache-semantics advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
affects every published release through 4.2.0. It entered through
`app-builder-lib → @electron/get@3.1.0 → got → cacheable-request`. The
[upstream proposed fix](https://github.com/kornelski/http-cache-semantics/pull/58) was still open,
and no patched release was available. Applying that proposal to version 4.2.0 would not make the
registry audit pass. Renaming its version or ignoring its advisory would misrepresent the result.

The parent-scoped override instead selects `@electron/get@5.1.0`, already used by Electron itself,
and removes the vulnerable HTTP response-cache chain. Electron's artifact cache and SHA-256
validation remain enabled. The package requires Node 22.12 or newer, matching the existing Electron
development dependency; compatibility was checked with Node 24.21.0.

`patches/app-builder-lib@26.15.3.patch` adapts only the builder's artifact-download call:

- The existing total request timeout becomes an abort signal covering the request and body.
- Existing HTTP/HTTPS proxy-agent URLs, credentials, headers and TLS settings are passed to
  undici's maintained proxy implementation. A package extension supplies the existing fixed undici
  release directly to this development dependency.
- Fetch HTTP status and network/timeout errors retain the properties used by the builder's retry
  policy. Progress notifications, artifact checksums and cache behavior retain their existing paths.
- Unsupported custom Got options or Node agents fail explicitly. They are not silently accepted
  and ignored by `fetch`; Aster's packaging configuration does not use those custom options.

The patch is owned by the Aster maintainers and pinned to `app-builder-lib@26.15.3`. Remove it, its
parent override and the package extension when an upstream builder release supports the fetch
downloader with equivalent timeout, proxy and retry behavior. Keep the compatibility tests while
evaluating that replacement.

## Validation and reference provenance

`scripts/electron-download-compat.test.mjs` exercises the installed, patched builder against local
HTTP and CONNECT servers. Its five tests cover HTTP 503 retry, checksum rejection, verified cache
reuse, a stalled request timeout, proxy authentication without credential leakage to the origin,
and explicit rejection of unsupported options. Results are retained at
`artifacts/migration/cycle4-electron-download-compat.log`.

The existing TS reference images are preserved. Updating Electron changes the host and source
provenance; the dependency audit and download tests do not establish pixel equivalence. Capture
upgrade candidates separately and compare them against the preserved references before approving
replacement reference provenance. Application smoke and the full migration gates remain separate
required checks.

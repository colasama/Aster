# Dependency policy

Dependencies must provide clear performance, security, or maintenance value that is not practical to
implement locally. Prefer actively maintained, memory-safe, cross-platform libraries with permissive
or weak-copyleft licenses compatible with MPL-2.0.

## Rules

- Lock all JavaScript and Rust dependency graphs and review lockfile diffs.
- Deny unknown registries, git dependencies without review, duplicate high-risk native libraries,
  unmaintained packages, and known vulnerabilities without a documented temporary exception.
- Keep GPU, file format, network, and plugin boundaries behind Aster-owned interfaces.
- Do not introduce CUDA-only core paths; hardware acceleration must have wgpu/platform portability.
- Secrets must not enter source, logs, project bundles, crash reports, or analytics.
- Run `cargo deny check`, `cargo audit`, `pnpm audit`, the test suites, and license generation before
  releases.

Exceptions require a short ADR or pull-request rationale with owner, risk, and removal date.

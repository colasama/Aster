# Contributing to Aster

Thank you for improving Aster. Start with a focused issue, describe observable behavior and
performance implications, and keep changes modular.

## Development workflow

1. Install the toolchain from `rust-toolchain.toml` and pnpm version from `package.json`.
2. Run `pnpm install --frozen-lockfile` and `pnpm prepare`.
3. Add tests for behavior and benchmark evidence for hot paths.
4. Run `pnpm check` before opening a pull request.
5. Use a gitmoji commit, such as `🐛 fix: preserve transient texture lifetime`.

GPU changes should document resource formats, lifetime, expected dispatch/draw counts, fallback
behavior, and before/after frame metrics. Project schema, plugin ABI, and structured operations must
remain backwards compatible or include a migration.

By participating, you agree to follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

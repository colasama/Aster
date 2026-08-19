# Aster Development Instructions

## Priorities

- Design GPU-first systems and keep frame data GPU-resident whenever practical.
- Favor predictable real-time performance, low interaction latency, and measurable behavior.
- Keep modules cohesive and loosely coupled. Split responsibilities before a file approaches an unmanageable size; do not create thousand-line source files.
- Prefer time-addressable evaluation (`evaluate(time)`) over frame-state-only updates.

## Validation

- Use Biome for frontend formatting and linting.
- Use lefthook to run the repository's frontend and Rust checks.
- Format Rust with `cargo fmt` and lint Rust with Clippy, treating warnings as errors.
- Run the relevant tests and builds before declaring work complete.

## Git

- Preserve unrelated user changes in the working tree.
- Use the gitmoji commit convention for every commit.
- Keep commits focused and describe the architectural intent in the commit body when it is not obvious.

## Documentation

- Keep architecture, project format, plugin ABI, and performance methodology documentation synchronized with implementation changes.
- Write project documentation and code comments in clear English unless a user-facing localization requires another language.

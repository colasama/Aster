# ADR 0001: Rust for the portable core

- Status: amended
- Date: 2026-08-20
- Amended: 2026-08-29

Use Rust for the portable timeline, model, renderer graph, persistence, plugins, and profiling core.
Rust provides predictable performance, memory safety without a garbage collector, strong
serialization types, and practical Windows/macOS/Linux support. UI experimentation remains in React;
typed operations keep that choice reversible.

The AI agent boundary is intentionally outside the Rust core. Pi runs in an isolated Electron utility
process and uses the renderer-owned TypeScript application service plus the versioned command registry
as its sole project-mutation path. The native desktop bridge supplies bounded privileged services, but
does not expose a separate AI planner or model-provider endpoint.

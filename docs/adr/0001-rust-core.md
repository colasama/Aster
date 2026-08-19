# ADR 0001: Rust for the portable core

- Status: accepted
- Date: 2026-08-20

Use Rust for the timeline, model, renderer graph, persistence, plugins, profiling, and native AI
boundary. Rust provides predictable performance, memory safety without a garbage collector, strong
serialization types, and practical Windows/macOS/Linux support. UI experimentation remains in React;
typed operations keep that choice reversible.

# ADR 0005: Time-addressable evaluation

- Status: accepted
- Date: 2026-08-20

Every property and deterministic simulation exposes evaluation at an arbitrary rational time. Seeking,
parallel export, caching, and AI edits must not require replay from frame zero. Temporal effects may
use explicit history resources, but their cache key includes time, inputs, parameters, and quality.

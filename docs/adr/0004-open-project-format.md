# ADR 0004: Open, versioned project format

- Status: accepted
- Date: 2026-08-20

Project source is documented, versioned, and independent from caches. Stable IDs and unknown-node
preservation allow external tools and missing-plugin recovery. Atomic writes, schema validation, and
pure migrations take priority over opaque compactness; packed/binary assets can be referenced by a
readable manifest.

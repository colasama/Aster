# Third-party licenses

Aster is distributed under MPL-2.0, while dependencies retain their original licenses. The primary
runtime families include Rust, Tauri, wgpu, React, Vite, Lucide, serde, glam, reqwest, and their
transitive dependencies.

The authoritative inventories are `Cargo.lock` and `pnpm-lock.yaml`. Before a release, generate the
complete attribution report from the exact lockfiles and attach it to the release artifact:

```bash
cargo deny check licenses sources bans advisories
pnpm licenses list --prod --json
```

No dependency license is relicensed by this file. If this summary conflicts with an upstream license,
the upstream license controls.

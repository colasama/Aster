# Plugin model

Aster plugins are declarative and capability-based. A `plugin.toml` manifest supplies a stable ID,
numeric semantic version, API version, WGSL entry point, capabilities, and typed parameters.

## Levels

1. **WGSL effect** — sandboxed shader plus declared inputs, outputs, and numeric parameters.
2. **Render graph** — declared passes and resources validated before insertion into the graph.
3. **Native** — explicitly trusted binary extension; disabled by default in untrusted projects.

Capabilities currently cover GPU render/compute, file read, and network access. Undeclared
capabilities are denied. Loading rejects unknown manifest fields, invalid IDs and versions, unsafe
or non-WGSL entry paths, missing/oversized shaders, WGSL parse or validation failures, invalid
parameter ranges, and duplicate keys.
Directory discovery isolates failures so one broken plugin cannot prevent other plugins loading.

## Installation and recovery

Open **Window → Plugins** in the native app to install a directory, refresh discovery, enable or
disable individual plugins, or enter safe mode. Aster validates the source before installation and
atomically swaps the installed directory. The v1 installer copies only `plugin.toml` and the shader
declared by that manifest; undeclared binaries and files are intentionally excluded. Reinstalling the
same plugin ID upgrades it without exposing a partially copied version.

Safe mode leaves individual enable/disable preferences intact but suppresses every third-party
plugin. Manifest and WGSL failures appear in the manager and never block other valid plugins.

## Minimal manifest

```toml
capabilities = ["gpu_render"]

[plugin]
id = "org.example.soft-glow"
name = "Soft Glow"
version = "0.1.0"
api_version = 1
shader = "shaders/soft-glow.wgsl"

[[parameters]]
type = "number"
name = "intensity"
label = "Intensity"
default = 1.0
min = 0.0
max = 10.0
```

Shader plugins receive only declared bindings. Render-graph plugins cannot read or overwrite a
resource without declaring the corresponding edge. Plugin failures isolate the node and preserve the
project data for recovery. The native ABI remains intentionally unstable and disabled for untrusted
projects in this milestone.

# Plugin model

Aster plugins are declarative and capability-based. A `plugin.toml` manifest supplies a stable ID,
numeric semantic version, API version, WGSL entry point, capabilities, and typed parameters.

Plugin authors can copy `examples/plugin-ci-template.yml` into their repository and replace the two
repository/ref placeholders with the final Aster slug and a pinned tag or commit. The workflow runs
the same manifest, WGSL, ABI, capability, and parameter validation used by the host application.

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

## Effect shader ABI v1

An effect exposes exactly one `@fragment` entry point named `aster_effect`. Its signature is:

```wgsl
@fragment
fn aster_effect(@location(0) uv: vec2f) -> @location(0) vec4f
```

The input UV is normalized with its origin at the top left. The output is linear, premultiplied RGBA.
The host exposes exactly these resources; additional bindings are rejected during installation:

| Binding | WGSL declaration | Meaning |
| --- | --- | --- |
| `@group(0) @binding(0)` | `var aster_source: texture_2d<f32>` | Linear source image |
| `@group(0) @binding(1)` | `var aster_sampler: sampler` | Clamping linear sampler |
| `@group(0) @binding(2)` | `var<uniform> aster: AsterEffectUniforms` | Frame and parameter data |

The uniform layout is stable for API version 1:

```wgsl
struct AsterEffectUniforms {
    resolution: vec2f,
    time: f32,
    parameter_count: u32,
    parameters: array<vec4f, 16>,
}
```

Each manifest parameter occupies one `vec4f` slot in declaration order. Number and choice values use
`.x`; colors use `.rgba`. Unused channels are zero. The 16-slot limit makes the uniform exactly 272
bytes and gives the host a bounded, backend-independent allocation. Texture parameters are reserved
for the render-graph ABI; v1 effects always receive the primary source texture shown above.

The loader parses and validates the complete module with Naga, then checks the entry signature,
resource count and types, and every uniform field name, type, offset, array stride, and total span.
See the installable [Tint](../examples/plugins/tint),
[Chromatic Aberration](../examples/plugins/chromatic-aberration), and
[CRT](../examples/plugins/crt) examples.

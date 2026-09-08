# Plugin model

Aster plugins are declarative and capability-based. A `plugin.toml` manifest supplies a stable ID,
numeric semantic version, API version, WGSL entry point, capabilities, and typed parameters.

Plugin authors can copy `examples/plugin-ci-template.yml` into their repository and replace the two
repository/ref placeholders with the final Aster slug and a pinned tag or commit. The workflow runs
the same manifest, WGSL, ABI, capability, and parameter validation used by the host application.

## Levels

1. **WGSL effect** — sandboxed shader plus declared inputs, outputs, and numeric parameters.
2. **Scene Generator** — host-scheduled compute phases and indirect procedural draws through ABI v1.
3. **Render graph** — declared passes and resources validated before insertion into the graph.
4. **Native** — explicitly trusted binary extension; disabled by default in untrusted projects.

Capabilities currently cover GPU render/compute, file read, and network access. Undeclared
capabilities are denied. Manifest discovery rejects unknown fields, invalid IDs and versions,
invalid parameter ranges, duplicate keys, and third-party use of the reserved
`org.aster.builtin.*` IDs. Installation and runtime activation additionally reject unsafe or
non-WGSL entry paths, missing/oversized shaders, and WGSL parse or validation failures. Both phases
isolate failures so one broken plugin cannot prevent other plugins loading.
Manifests are capped at 1 MiB, display strings and choice sets are bounded, and duplicate plugin IDs
are isolated before executable sources enter the renderer-facing registry.

## Installation and recovery

Open **Window → Plugins** in the native app to install a directory, refresh discovery, enable or
disable individual plugins, or enter safe mode. Aster validates the source before installation and
atomically swaps the installed directory. The v1 installer copies only `plugin.toml` and the shaders
declared by that manifest graph; undeclared binaries and files are intentionally excluded. Reinstalling the
same plugin ID upgrades it without exposing a partially copied version.

Safe mode leaves individual enable/disable preferences intact but suppresses every third-party
plugin. Manifest and WGSL failures appear in the manager and never block other valid plugins.

## Runtime activation

Plugin discovery and plugin execution are separate phases. Opening the plugin manager reads bounded
`plugin.toml` metadata only, so an installed package can be listed without opening, transferring, or
compiling its WGSL payload. A runtime is activated only when the user selects **Load** or when an
opened project references the plugin ID in an effect or Scene Generator node. The desktop bridge then
reads and validates shaders for exactly the requested IDs, and the renderer registry receives only
those validated payloads. Missing or disabled project plugins remain preserved as isolated no-op
nodes until their runtime becomes available.

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

## Scene Generator ABI v1

A Scene Generator is a GPU-authored scene node, not a particle-specific callback. Set
`plugin.kind = "scene_generator"`, request both `gpu_compute` and `gpu_render`, and declare one
`[scene_generator]` graph. The graph identifies a capacity parameter, a bounded storage-record
stride, ordered compute phases, and one or more render variants. Variants may be selected by a
choice parameter and independently declare vertex count, blend behavior, depth reads/writes, culling,
and an optional auxiliary-MRT entry point.

```toml
capabilities = ["gpu_compute", "gpu_render"]

[plugin]
id = "org.example.points"
name = "Points"
version = "1.0.0"
api_version = 1
shader = "compute.wgsl"
kind = "scene_generator"

[scene_generator]
api_version = 1
node_type = "points"
capacity_parameter = "count"
max_instances = 250000
instance_stride = 16

[[scene_generator.compute_passes]]
id = "generate"
shader = "compute.wgsl"
entry_point = "compute_main"
workgroup_size = [256, 1, 1]
phase = "simulation"

[[scene_generator.render_variants]]
id = "points"
shader = "render.wgsl"
vertex_entry = "vertex_main"
fragment_entry = "fragment_main"
vertex_count = 6
blend = "add"
depth = "none"
cull = "none"
```

The host owns every buffer and command encoder. Compute modules receive exactly four bindings:

| Binding | WGSL declaration | Meaning |
| --- | --- | --- |
| 0 | `var<uniform> aster_context: AsterGeneratorContext` | Resolution, composition/local time, frame duration, count/stable instance seed, layer transform, camera, composition size, render IDs |
| 1 | `var<uniform> aster_parameters: AsterGeneratorParameters` | 128 `vec4f` parameter slots in manifest order |
| 2 | `var<storage, read_write> aster_instances` | Host-sized instance records using the declared stride |
| 3 | `var<storage, read_write> aster_draw: AsterDrawIndirect` | Host-reset indexed-free indirect draw record; compute atomically emits visible instances |

Render modules receive context and parameters at bindings 0 and 1, and the same instance buffer as
read-only storage at binding 2. They never receive a raw device, encoder, surface, filesystem path,
or host pointer. The standard context is time-addressable and includes both composition and
layer-local time, so seeking and precomposition evaluation do not depend on previous frames.

The standard buffers have exact binary layouts in API v1. Plugins must reproduce these declarations
(field names are part of the conformance contract):

```wgsl
struct AsterGeneratorContext {
  resolution: vec2f,
  composition_time: f32,
  local_time: f32,
  frame_duration: f32,
  reserved_time: f32,
  instance_count: u32,
  instance_seed: u32,
  layer_position_opacity: vec4f,
  layer_rotation: vec4f,
  layer_scale: vec4f,
  camera_position: vec4f,
  camera_rotation: vec4f,
  camera_projection: vec4f,
  composition: vec4f,
  ids: vec4u,
  camera_right: vec4f,
  camera_down: vec4f,
  camera_forward: vec4f,
}

struct AsterGeneratorParameters {
  values: array<vec4f, 128>,
}

struct AsterDrawIndirect {
  vertex_count: u32,
  instance_count: atomic<u32>,
  first_vertex: u32,
  first_instance: u32,
}
```

`camera_projection` packs orthographic flag, horizontal angle of view in radians, orthographic
height, and Zoom in composition pixels. The three appended unit basis vectors are authoritative
for one-node and point-of-interest cameras; `camera_rotation` remains available to older module
logic and diagnostics. Appending the basis preserves every existing field offset while extending
the standard context buffer from 160 to 208 bytes.

`aster_instances` must be a runtime-sized array whose WGSL stride equals `instance_stride` in the
manifest. The record shape is plugin-defined; the host owns its capacity and allocation lifetime.
Vertex entries are procedural: they may read only the `u32` `vertex_index` and `instance_index`
built-ins and must write `@builtin(position) vec4f`; no host vertex buffer is exposed. A beauty
fragment entry must write exactly `@location(0) vec4f`. An auxiliary fragment entry must write the
five host MRT locations in order: normal `vec4f`, object ID `u32`, material ID `u32`, world position
`vec4f`, and motion vector `vec2f`. The installer also verifies that every fragment location it reads
is emitted with the same type by its paired vertex entry.
Because compute modules expose a writable indirect-draw binding while render modules do not, a WGSL
file cannot be referenced by both stage types. Multiple compute passes may share a compute file, and
beauty/auxiliary variants may share a render file.

Before installation, Rust parses and validates every declared WGSL module with Naga, verifies entry
stages, workgroup sizes, every standard-buffer field name/type/offset/span, the declared instance
stride, paths, capabilities, identifiers, and quotas. Current hard limits are 128 parameters,
1,000,000 instances, a 256-byte instance stride, 512 MiB declared storage, eight compute phases,
eight render variants, 65,535 vertices per instance, 4 MiB per WGSL file, and 16 MiB of WGSL per
plugin package. Runtime memory pressure may lower effective
instance count without changing project data; adapter storage and compute-dispatch limits are always
stricter upper bounds. Adapters without the five-target auxiliary MRT still render Beauty and simply
omit generator auxiliary output. Registry refreshes are content-addressed: unchanged
definitions retain their GPU buffers, while an edited or removed generator invalidates only its own
runtime resources.

The installable [Point Cloud](../examples/plugins/point-cloud) example is a complete third-party
generator. The bundled particle system is registered as `org.aster.builtin.particles` and goes
through the same compiler, resource owner, indirect draw, camera/transform, precomposition, cloner,
and auxiliary-buffer route.

## Growing host capabilities

New plugin power belongs in small, versioned host services rather than direct access to editor or
GPU internals. The core should remain the owner of project transactions, rational timeline
evaluation, render-graph scheduling, GPU allocation, asset resolution, cache lifetime, diagnostics,
profiling, and permission grants. A plugin receives stable handles or packed snapshots for only the
services named by its manifest capabilities.

When a new need appears, add it in this order:

1. Define the deterministic data contract and its resource limits independently of a particular
   plugin.
2. Add a narrowly named capability and installation-time validation.
3. Expose a versioned host service or declarative graph field; never expose the editor store,
   command encoder, raw filesystem, or ambient network access.
4. Make missing support discoverable through feature negotiation and preserve the plugin node in
   the project instead of destructively downgrading it.
5. Add conformance fixtures, malformed-input tests, performance counters, cancellation, and a
   failure-isolation path before enabling the capability by default.

Likely next services are host-owned sampled textures and meshes, audio-analysis buffers, persistent
cache handles keyed by time and inputs, and asynchronous import jobs. They should remain separate
capabilities so a procedural mesh generator does not automatically gain file or network access.

## Native extension draft (disabled in the MVP)

Native plugins are a future trusted-only escape hatch, not an alternative path around the WGSL
sandbox. The host never loads a plugin library into the editor process. It starts a per-publisher
plugin-host process, negotiates an exact ABI version, and exchanges size-bounded messages and shared
GPU handles through a platform broker. A timeout, malformed response, device loss, or process crash
disables that node while the editor preserves the project and autosave.

The C boundary is deliberately small and allocator-neutral. Every structure starts with its byte
size and ABI version; strings and buffers are borrowed pointer/length pairs valid only for the call.
The plugin returns status codes, never exceptions, and releases its own opaque handles:

```c
typedef struct AsterHostV1 AsterHostV1;
typedef struct AsterPluginV1 AsterPluginV1;

typedef struct {
  uint32_t struct_size;
  uint32_t abi_version;
  const uint8_t *manifest_json;
  uint64_t manifest_len;
} AsterPluginCreateInfoV1;

typedef int32_t (*AsterPluginCreateV1)(
  const AsterHostV1 *host,
  const AsterPluginCreateInfoV1 *info,
  AsterPluginV1 **plugin);

typedef void (*AsterPluginDestroyV1)(AsterPluginV1 *plugin);
```

The Rust author API is a safe adapter over that C contract. Its draft surface is a `Plugin` trait
with `manifest()`, `prepare(&mut PrepareContext)`, and `evaluate(&mut FrameContext)` methods. Contexts
expose only capability-checked handles; they do not expose raw `wgpu::Device`, filesystem paths, host
pointers, or a Tokio runtime. The adapter catches panics at every FFI entry, validates lengths before
creating slices, and maps errors to stable numeric status codes. `unsafe` is confined to the adapter
crate and denied in plugin-facing SDK crates.

No native ABI is stable during `0.x`. A future stable ABI increments only by adding size-gated tail
fields or new entry points; changing field meaning, ownership, alignment, or required behavior needs
a new major ABI. The host supports only explicitly listed versions and never guesses compatibility.
The Rust trait itself has no binary-stability promise: Rust plugins compile against an SDK release
that targets one C ABI version.

Native capability policy is deny-by-default. GPU compute/render, scoped file reads/writes, network,
audio input, and process spawning are separate grants shown at installation and again when expanded.
Raw device access, arbitrary host memory, debugger attachment, and unsandboxed child processes are
never grantable. Signed publisher identity does not imply capabilities. Native loading remains off
until the process sandbox, handle broker, watchdog, crash-loop suppression, and conformance suite are
implemented on every supported desktop platform.

# Point Cloud Scene Generator

This directory is a complete third-party Scene Generator plugin for ABI v1. It demonstrates a
time-addressable compute pass, a host-owned runtime-sized instance buffer, atomic indirect draw
emission, typed manifest parameters, and a procedural Beauty render pass.

Validate it from the repository root:

```sh
cargo run -p aster-plugin --example validate -- examples/plugins/point-cloud
```

In the native application, open **Window → Plugins**, choose **Install folder**, and select this
directory. The generator then appears by its manifest name in the Project panel's add menu. Copy the
directory under a new reverse-domain plugin ID before using it as a project template.

The host owns device access, command scheduling, buffers, indirect draw records, transforms, camera
data, time, memory limits, and failure isolation. The plugin owns only its declarative graph,
parameters, instance-record layout, and validated WGSL entry points. See
[`docs/PLUGINS.md`](../../../docs/PLUGINS.md) for the exact standard-buffer and render-output layouts.

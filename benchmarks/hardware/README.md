# Benchmark hardware manifests

Every published Aster performance result must name a committed hardware manifest and retain the raw
benchmark JSON. The primary MVP development baseline uses
[`windows-rtx5060-laptop.json`](./windows-rtx5060-laptop.json).

Before recording a primary result:

1. Connect AC power, select the Windows **Best performance** power mode, and close nonessential GPU
   workloads.
2. Force Aster and every comparison application onto the discrete NVIDIA adapter through Windows
   Graphics settings.
3. Confirm the adapter string in Aster's downloaded report identifies the NVIDIA adapter. Reject the
   run if it reports the integrated or a virtual adapter.
4. Record the display topology, refresh rate, Aster commit, application versions, and ambient or GPU
   temperature when the measurement tool exposes it.
5. Run the complete warm-up suite, then collect the measurement suite without changing power,
   display, quality, or adapter settings.

The manifest intentionally excludes hostnames, usernames, serial numbers, GPU UUIDs, and hardware
instance IDs. Windows CIM supplied the OS, CPU, physical-memory, and adapter identity fields;
`nvidia-smi` supplied the NVIDIA memory, power-limit, clock-limit, and vendor-driver fields. The
OS-reported visible memory value is recorded separately from physical DIMM capacity. A driver, OS
build, power mode, or display-topology change starts a new baseline series; do not silently merge it
with the existing series.

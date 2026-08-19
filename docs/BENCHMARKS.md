# Benchmark methodology

Measure release builds after pipeline warm-up on AC power with the same project seed, resolution,
preview quality, driver, and adapter. Record median, p95, and p99 over at least 600 frames.

## Suites

- 1080p and 4K 20-layer 2D composite.
- Large-radius blur, glow, and mixed effect chains.
- 100,000 and 1,000,000 compute particles.
- 3D scene with PBR lights and auxiliary buffers.
- Hardware decode, seek, frame upload, full-resolution export, and sustained PNG sequence export.

Report CPU submit time, GPU frame/pass time, FPS, draw/dispatch counts, upload bytes, transient texture
count, peak estimated VRAM, cache hit rate, and shader/pipeline compilation events. Commit machine-
readable JSON baselines; a regression is more than 5% median or 10% p95 unless the change documents an
intentional quality tradeoff.

For sequence export, also report frames per second, median GPU render time, median PNG encode/write
time, peak resident memory, and cancellation latency. Use at least 300 frames and a pre-selected local
SSD output directory so the directory picker is outside the measured interval.

# Competitor comparison protocol v1

This protocol defines how Aster may make a public performance comparison without favoring an
application through unequal input, quality, or measurement conditions. It is a preregistered method,
not evidence that Aster is faster than another product.

## Freeze the comparison before measuring

Publish the following before collecting results:

- the Aster commit, competitor product/version, operating-system build, GPU driver, and committed
  hardware manifest;
- a screen-recorded construction walkthrough or editable source for each application;
- the exact composition dimensions, rational frame rate, duration, layer order, blend modes, effect
  parameters, color management, bit depth, preview scale, and export settings;
- the metric source for each product: GPU timestamp, product profiler, external frame capture, or
  wall-clock export timing;
- the warm-up count, sample count, run count, aggregation rule, and exclusion criteria below.

Do not change those fields after seeing results. A correction creates a new comparison revision and
keeps the superseded raw data available.

## Build equivalent workloads

Rebuild the same visible workload in each application from shared, redistributable source assets.
Use the same font file and media bytes rather than substituting installed fonts or transcoded media.
Match output pixels and effect quality, not marketing preset names. When algorithms differ, choose the
settings with the closest radius, sample count, color space, edge behavior, and visible result, then
publish side-by-side reference frames.

The minimal shape-only fixture in [`../../examples/projects`](../../examples/projects) is the
conformance starting point. Performance comparisons use the benchmark suites documented in
[`../../docs/BENCHMARKS.md`](../../docs/BENCHMARKS.md); the minimal fixture alone is too small for a
meaningful speed claim.

If a competitor cannot implement a scenario, report it as **unsupported**. Do not replace it with an
easier scenario, assign it a synthetic score, or remove it from Aster's results. Disable caching only
when every application exposes an equivalent control. Otherwise report normal interactive behavior
and separately document measured cache state.

## Control the machine

- Run every application on the same manifest machine, OS session, discrete adapter, driver, display
  topology, refresh rate, AC power state, and performance power mode.
- Disable VSync or frame caps only when the same control exists in every product. Never derive an
  uncapped result from a capped counter.
- Close nonessential foreground and GPU-intensive applications. Run products sequentially, rotate
  product order between repetitions, and restart an application between recorded runs.
- Complete one unrecorded full-suite warm-up for each product. Record thermal or clock telemetry when
  available and discard a run only for a preregistered reason such as power loss, adapter mismatch,
  application crash, or thermal throttling flag.

## Collect and report

For interactive playback, advance the same rational-frame sequence and collect at least 600 measured
frames after at least 10 warm-up frames. Perform three recorded runs per product. For export, use at
least 300 frames to a preselected local SSD directory and exclude file-picker time.

Publish every raw run. Per run, report minimum, median, p95, p99, and maximum for wall, CPU-submit, and
GPU time when available. The headline value is the median of the three run medians; tail latency is
the largest of the three p95 values. FPS may be derived from uncapped frame time but must not replace
latency distributions. Export reports include throughput, encode/write time, peak resident memory,
and cancellation latency.

Differences inside the measurement tool's resolution or below 5% median and 10% p95 are **no material
difference**, not a win. Label metrics collected from different timing sources and do not put them in
one ratio. Include visual reference frames, raw JSON/CSV, construction sources, logs, exclusions, and
unsupported scenarios with the published summary. Never generalize one machine, project, or product
version into a universal performance claim.

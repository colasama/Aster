# Backend performance review — 2026-09-12

## Outcome and scope

This change optimizes native Rust render-resource management in `aster-render`. At 2,048 live
resources, local release measurements reduced graph compilation median from 2.5933 ms to
0.4963 ms (80.9%) and warmed pool acquire/release/statistics from 11.091 microseconds to
0.047 microseconds per operation (99.6%). These are CPU microbenchmarks, not editor FPS gains.
The current Electron preview uses a separate browser WebGPU renderer.

The review inspected dependency evaluation, evaluation/media/text caches, native render graphs
and resource pools, and desktop bridge/project storage paths. It was a source-level review with
targeted measurements, not a complete end-to-end application profile. No frontend rendering,
project format, plugin ABI, shader, or media decode behavior changed. No dependencies were added.

## Implemented changes

### Transient resource allocation

Previously the allocator walked resources in creation order and linearly searched every existing
slot. With overlapping resources this incurred quadratic slot comparisons. Creation order could
also prevent reuse when lifetimes ran in the opposite order.

The allocator now visits passes in execution order to collect lifetimes, sorts resource intervals
by first use, and uses a descriptor-keyed min-heap of slot availability. Slot assignment takes
O(R log R) work rather than O(R squared) worst-case comparisons, for R used resources. Descriptor
matching includes dimensions, format and samples. A slot is reusable only when its last use is
strictly before the next first use; persistent resources never enter the reuse heap. Returned
allocations remain ordered by resource handle. Slot numbers are derived output and may change.

A regression fixture with 32 serial, reverse-created 4K RGBA16Float resources now needs one
estimated slot rather than the previous algorithm's 32: 63.28125 MiB rather than 2,025 MiB.
This is descriptor-based allocation accounting, not an observed device-memory measurement.

### Resource pool accounting

Previously every release summed all descriptor sizes to check the budget, and statistics scanned
entries again for byte and lease totals. The pool now updates these totals on allocation,
reuse, release and eviction. Statistics and the budget comparison are O(1); ordinary acquisition
and release still include O(log N) map lookups. Snapshots use the existing BTreeMap order without
sorting it a second time.

Internal byte accumulation uses u128, while the public u64 estimate saturates. This keeps budget
decisions correct and allows accounting to recover after multiple individually saturated
descriptors are evicted. Leased resources remain protected even if they exceed the budget.
Eviction still searches available entries for the oldest resource; that path was not redesigned.

## Measurements

Base source: `f28caf4b4488afdb96bc0f7426a0fd310a9bcbf9`. The before executable was built from the
original backend plus the new benchmark example; the after executable used the optimized backend
and the same example workload. Source formatting does not change the workload. The implementation,
example and raw data are versioned with this report.

Environment: AMD Ryzen 9 8945HX, Windows 10.0.26100, x86_64-pc-windows-msvc, rustc 1.97.1
(`8bab26f4f`, LLVM 22.1.6), workspace release profile (opt-level 3, thin LTO, one codegen unit).
Power mode, thermal state and background application load were not controlled. These are local
diagnostics, not baselines qualified against the project's fixed GPU hardware manifest.

Each run used 20 warm-up samples and 600 measured samples. Pool samples averaged 100 operations.
The main sequence was before/after, after/before, before/after, with no concurrent build. The table
uses the median of the three per-run medians and the median of the three per-run p95 values.
All individual timings are retained in the [raw results directory](../benchmarks/results/backend-resources-2026-09-12).

| Scenario, 2,048 resources | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| Compile overlapping transient resources | 2.5933 ms | 0.4963 ms | 2.9394 ms | 0.5865 ms |
| Pool acquire/release/statistics per operation | 11.091 us | 0.047 us | 12.874 us | 0.063 us |

Graph compilation includes validation, scheduling and allocation planning; construction and
destruction are outside the timed interval. All 2,048 resources overlap, so the benchmark asserts
that none are aliased. Pool payloads are `()` and no actual GPU allocation, submission, synchronization
or readback is measured. The 100-operation averages are not individual-operation tail latencies.

A separate single-pair 16-resource smoke comparison measured graph compilation at 2.1 us before
and 2.4 us after (p95 3.7 us and 2.7 us), and pool operations at 93 ns and 24 ns. The 0.3 us graph
median increase is a small-workload tradeoff from ordering and heap bookkeeping, not a claimed
improvement. One pair and timer quantization do not establish a stable regression percentage.
If representative small graphs dominate native workloads, repeat that workload before considering
a second allocation strategy. The main benchmarks intentionally exercise large resource counts.

Reproduce on each revision with the identical example:

```shell
cargo build --release -p aster-render --example resource_performance
target/release/examples/resource_performance
target/release/examples/resource_performance --resources 16
```

Keep separate before and after executables and alternate their execution. The JSON includes
options, OS, architecture and raw samples. Source and executable SHA-256 metadata is not included
in this capture. Details are in [Benchmark methodology](BENCHMARKS.md).

## Validation

- Four new regression tests cover reverse creation/execution order, touching lifetimes and
  incompatible descriptors, pool reuse/eviction/invalid releases, and byte-total overflow recovery.
- `cargo test -p aster-render`: 16 passed, 5 existing native-adapter tests ignored.
- Lefthook Rust workspace test job: 165 passed, 12 existing tests ignored, no failures.
- Lefthook pre-commit Rust checks: `cargo fmt --all --check` and
  `cargo clippy --workspace --all-targets --all-features -- -D warnings` passed.
- `cargo build --release --workspace --all-features` passed.

Native GPU tests are opt-in and were not run; this change concerns CPU scheduling and resource
accounting. Frontend rendering changes are outside the scope of this report.

## Remaining opportunities

| Candidate | Evidence from code | Next useful measurement |
| --- | --- | --- |
| Sparse dependency evaluation | `DependencyGraph::take_evaluation_order` scans cached full topology for a small dirty set. | Existing 10k-node full/leaf benchmark, plus mixed dirty-set sizes before choosing an index. |
| Evaluation-cache hits | `EvaluationCache::get` retains the entire recency deque on each hit. | Hit-heavy workloads at representative cache capacities; weigh a recency index against added metadata. |
| Media, glyph and GPU-cache eviction | Several LRU implementations search entries for the oldest item. | Seek bursts and budget reductions with realistic item sizes; report p95 and number evicted. |
| Pool budget trimming | Running totals remove repeated byte sums, but each eviction still searches entries and edits the free list. | Large budget reductions before adding a maintained eviction index. |
| Desktop media/save paths | Existing paths already stream or buffer file I/O; a source review cannot rank storage latency against decode or IPC. | Trace import/save/export with representative assets and cancellation before changing buffering or concurrency. |

These candidates remain unchanged because this pass did not establish their end-to-end impact.
No frame pixels were moved to the CPU as part of the optimization.

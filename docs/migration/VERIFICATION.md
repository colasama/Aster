# Renderer migration verification

The progress ledger identifies the active task and approved reference source. Run commands from the
repository root on `feature/rust-renderer`. Preserve an existing `ASTER_PERF_PROJECT`; otherwise set it
to the owner's project directory (`D:\code\SD04PV` on the authorized local Windows host).

`pnpm migrate:verify --milestone M0` runs the complete static and Electron application checks. During
the M0 exit task it also audits the reference corpus, deliberately rejected oracle probe, committed
performance baseline, and whole-corpus TS exact comparison. A failed exit audit returns a nonzero
status while retaining the actual individual gate results. `--quick` never establishes milestone
completion.

## Preserving the pixel oracle

The original M0 reference remains in `artifacts/parity/reference/`, pinned by
`reference_baseline.renderer_source_sha256` in the ledger. Explicit `reference_repairs` may overlay
individual requested frames during M0 after section 6.6 self-review. Each overlay retains its real
capture source and evidence; it does not rewrite original files or sequence neighbors. The normal
`parity:capture` command creates or refreshes references; do not use it to test a changed renderer
against an existing baseline.

1. Run `pnpm parity:capture --candidate` to capture the current production TS renderer into a separate
   run directory. This bypasses reference caching and never publishes into the reference directory.
2. Run `pnpm parity:check-ts --candidates <candidate-manifest-path>` using the manifest reported by
   the capture. This invokes the real comparison CLI with `exact` for every required corpus frame.
   It does not capture or modify references.
3. Record the capture report, manifest and exact report paths in the M0 exit task's `exit_evidence`
   (`candidateCaptureReportPath`, `candidateManifestPath`, `exactReportPath`), then run the full
   migration verification command. The audit checks their underlying files and source bindings.

Diagnostic capture accepts `--timeout-ms` from 1,000 to 1,200,000 per case. Long sequences that
capture resources and independently replay every frame can require more than ten minutes. A timeout
remains a failed run; retry with an explicit larger deadline without changing pixel acceptance.

Keep source files unchanged while capture, comparison or gate execution is running. Candidate output
contains the requested frames and any sequence neighbors. Full G3 comparison covers the requested
addresses; it does not authorize promotion of additional neighbor frames into a new reference set.
The renderer fingerprint hashes existing source bytes independently of Git staging. Removed tracked
files leave that content set; the full-tree provenance also records unstaged deletions explicitly.
The effective reference set must be fixed before M1. Each repaired frame must come from a separate
capture run from the candidate used to prove exact parity; comparing a capture to itself is invalid.
The original particle oracle used atomic append order, which could change transparent blending and
mesh occlusion between identical evaluations. M0 fixes the general ordering defect and records one
reviewed billboard-frame repair. Failed comparisons against the original remain failed. The M1/M2
exact thresholds are unchanged.

Comparison artifacts are published as one complete directory under a create-new lock. On Windows,
only the final directory rename retries access/sharing errors (OS codes 5, 32 and 33). The CLI defaults
to five attempts with a 20 ms initial exponential delay, retaining the complete staging directory and
checking that the destination remains absent before every attempt. The configurable bounds permit
at most five attempts and a 50 ms initial delay. Other I/O failures and exhausted retries fail the
comparison with operation/path context; they never count as accepted pixels or reuse partial output.

## Shared-shader increments

M1 shares output AA, core scene variants, compositing, fused post-processing, blur/depth/surface
effects, auxiliary surfaces, particles, text motion blur, display/buffer helpers and generator/audio
ABI declarations in `shaders/`. The TS catalog loads raw WGSL through Vite, and `aster-shaders`
embeds the same files and validates the manifest's assembled programs with Naga. Fragment order,
entry points and typed pipeline overrides come from `shaders/manifest.json`. Fixed unsigned integer recipe items
preserve the existing shader-creation layout constants without expression evaluation. Original
expanded-source hashes protect both scene variants and the static helpers; lighting uniform size
remains 592 bytes for eight lights. Helper modules without entry points are still Naga-validated.
Motion blur replaces only its four fixed tile-size insertions with a typed WGSL override. Its
16-pixel default also controls host allocation; restoring those four literals and removing the
override declaration must reproduce the original source hash. Whole-corpus exact G3 validates the
resulting pipeline output.

The fused post-process recipe owns the warp and pixel case order, dependent helpers and exact
fragment boundaries. Its root-only `root_zero_operations` specialization follows the validated
zero-operation upload contract; the default remains dynamic for layer effects. Tests pin the full
assembled source and check the production pipeline's specialization. Rust validates the complete
assembled program with Naga; switch-case
fragments cannot be validated as independent modules. Tests also retain the eight binding slots,
host layouts, entry points and typed override default. Whole-corpus exact G3 remains required.

The generator, audio, text and diagnostic programs retain their original expanded-source hashes.
Scene-generator context, parameter, particle and audio buffer layouts remain unchanged; the audio
arrays have fixed ABI lengths, not pipeline overrides. A direct raw import keeps the CPU audio
module independent of the renderer catalog.

For each M1 increment, freeze the source tree, run `pnpm parity:capture --candidate` for the full
corpus, then run `pnpm migrate:verify --milestone M1 --candidates <candidate-manifest-path>`.
The ledger's `active_candidate_manifest` supplies that path when `--candidates` is omitted.
G3 audits the full capture report and frame provenance against the current renderer source before
requiring exact pixels for every requested frame. A previous capture from different renderer sources or
a diagnostic subset cannot satisfy this gate. Comparison never creates or refreshes references.

The M1 ledger's `frozen_reference` must equal the completed M0 effective reference binding, including
the original source pin and the exact reviewed repair set. Neither that binding nor the repair set
may change to accommodate shader extraction. Passing G0/G3 for one task establishes that increment
only. The original reference files must also retain the aggregate digest recorded by the completed
M0 verification, and candidate project, media, plugin and frame inputs must match those references.
M1 exit additionally requires every shader to be shared and Naga-valid, the enforced absence of
WGSL string literals throughout `src/`, and the remaining section 5 work.

When `M1-T6` is active or complete, a full M1 run also performs the shared-source exit audit.
The AST scan reads every TS/TSX source file, including tests, and rejects marked or unmarked inline
WGSL implementations and literal-derived shader compiler inputs. Short syntax assertions and
non-WGSL mock values are classified separately. Disk WGSL paths must exactly match the manifest,
all fragments must be used, and Rust tests compare the embedded files with the same disk sources
before validating all assembled programs with Naga.

The effect-shot harness writes only compiled operation data and shader digests. Its registered
effect types must match the canonical effect cases in the parity corpus. The exit run creates a
fresh manifest, runs the native `effect_shots` example with the shared catalog, and audits every PNG
and the native report before publishing its output directory. This is a native shader smoke test;
it does not compare default-parameter diagnostic images with the richer corpus reference images or
replace native effect parity in M4. Current full TS exact G3 remains the M1 pixel gate.

The exit audit binds the source inventory, current G0/Naga results, current full exact G3 and native
shader smoke to one source tree. Quick checks, stale evidence, missing prerequisites, incomplete
coverage or failed output audits cannot establish M1 completion.

## Frame-plan transport and consumption

Under the approved `rust-delivery-v1` policy, M2 requires G0, G1 and G3; performance observations
do not block TS plan extraction. The runner rejects a ledger gate list that omits or duplicates a
required gate. Full G1 regenerates the Rust-owned schema into a fresh output and runs actual
TS-to-Rust-to-TS canonical FPLN round trips. Expected schema bytes are never overwritten during
verification. Container boundaries, resource hashes and budgets have separate negative tests.
Root producer fixtures also round-trip signed zero, subnormal and extreme finite times, fractional
seek requests and exact decimal-rate metadata. Their decoded time bits and actual supplied uniform
uploads are checked independently of the original request.
Scene-buffer fixtures add nested composition, camera, mesh, lighting and motion payloads plus empty
geometry. G1 round-trips them through Rust and checks decoded uploads and shadow ranges. Mutation
tests verify producer ownership, borrowed unaligned views and destination replacement on resizing.
Evaluated camera fixtures cover nested perspective and orthographic cameras with exact f64 payloads.
Their decoded pose, projection and optics match TS evaluation; consumer tests compare geometry,
lighting, generator context and depth uniforms and verify that changed supplied bytes alter geometry.
Media lease tests exercise atomic acquisition, changed-source/frame rejection, abort and delayed GPU
completion across cache destruction, including the shared placeholder owner. Full G3 remains required
for media draw adapter changes; these lease tests alone do not establish content-addressed replay.
G1 also sends image/sequence/video/raster resource messages through the Rust CLI registry and back to TS,
checking exact descriptor hashes, requested/uploaded time values and ordered eviction. Wrong hashes,
kind mismatches, missing sources and premature source eviction must fail. Registry tests cover
exact text/SVG/PSD raster bounds, including signed zero and fractional values; nonfinite bounds must
be rejected before registry admission. Ordinary text upload tests check stable retained generations
and stale lease rejection after changed font/source uploads. Registry tests also cover
descriptor budgets, ownership across asynchronous hashing and in-flight frame/source dependencies.
Production adapter tests validate installed still extents after bitmap closure, resolved sequence
members, actual video upload times, and drawing by supplied hash independently of instance IDs.
G1 round-trips temporal text samples from the actual shutter planner for full, entering and exiting
exposure. It also admits five packed texture resources through Rust: identity/custom 3D LUTs,
linear RGBA8 normal texels, RGBA16F HDR texels, and an actual two-row Radiance decode with worker
padding removed. The decoded descriptors and pixels drive recorded
production GPU uploads with exact format, extent and row/layer layout. Both registries reject
corrupted pixels; upload tests reject descriptor/hash corruption before allocation.
The identity/custom LUT fixtures originate in the production selection planner. Selection tests
cover last-enabled-loaded precedence, owned bytes after authoring mutation, source-key reuse and
eviction. Effect consumer tests upload a cloned selection after its authored LUT changes, reuse an
unchanged hash without another upload, and destroy replaced/swept GPU owners. Root and precomposition
adapters are exercised by full G3, including nonlinear trilinear/tetrahedral LUT corpus cases.
Material tests
mutate authoring inputs after preparation, check supplied uniforms and pending fallback behavior,
reject retired generations, and retire a normal upload while GPU validation is pending.
G1 transports five material binding slices through Rust: inactive, normal-only, environment-only,
combined and exact-bit scalars. Decoded binary64 values, tagged texture hashes, UTF-16 instance
identities and production float32 uniforms must match exactly. A hash registry resolves decoded
references independently of authoring IDs and rejects missing or wrong-role owners. These checks
establish binding transport; they do not establish complete material shader draw replay.
G3 also verifies PNG/JPEG/WebP normal uploads outside the legacy scene corpus. A pinned legacy
uploader records actual linear RGBA8 texture bytes, then its GPU device and page are destroyed.
Encoded resource messages and payloads pass through Rust before a new page/device decodes and uploads
them. Every replay texel must match exactly; the consumer never receives reference pixels. The gate
audits saved payload hashes, Rust-returned messages and both pixel buffers. This verifies normal
resource upload. A separate required material-draw audit transports one scene and six material plans
through Rust together with encoded normal and packed HDR resources. The original page/device is
destroyed before the production GPU binding consumer replays only the supplied data. Inactive,
normal, negative normal scale, environment, rotated environment and combined draws compare exactly
against separately frozen 64x48 RGBA16F buffers. The reference uses the pre-extraction binding logic,
direct evaluated scene buffers, legacy normal upload and padded decoded HDR pixels. All six outputs
must differ and contain visible geometry. The audit pins the reference implementation and buffers,
verifies seven exact FPLN round trips and both resource hashes, and compares saved GPU output bytes.
This is material draw coverage, not complete captured-frame replay.
Temporal sample fixtures cover full, entering and exiting
exposure, plus transparent and exact-bit fixtures. Supplied samples and exposure identities must
survive Rust decoding and TS cloning; invalid formats, frame time, weights and sample lanes fail.
G1 additionally transports hash-addressed accumulation/resolve plans through Rust in four fixtures:
full exposure, partial exposure, transparent-only and exact-bit weights (including negative zero
and a subnormal). Reconstructed ordered hashes drive recorded draw bindings and reconstructed f64
weights drive the final f32 uniform writes. TS and Rust reject malformed dependency/exposure inputs.
G3 captures the production pass slice and individual sampled rasters before submission cleanup.
It round-trips the captured FPLN through Rust and loads a separate replay page after destroying the
original device. That consumer imports no authoring evaluators and receives no resolved output
pixels: it uploads decoded samples into new allocations and executes supplied accumulation/resolve.
Saved sample payloads, resource dependencies, FPLN bytes and independent GPU output are audited;
any missing or changed evidence fails the gate. Complete submitted-frame replay remains open.
The temporal upload boundary test revokes authoring-layer access and mutates original samples after
acquisition, then checks that uploads retain the acquired canvases and copied weights. The pass
executor test discards producer weights and executes a cloned plan with an independently changed
weight. Extent, output binding, sample slot, missing resource, uniform storage and duplicate hash
errors must fail before any GPU write or render pass.
Malformed prepared extents or sample counts must fail before GPU allocation. Full G3 still verifies
the production cache, accumulation and resolve path against exact reference pixels.
Temporal output lifetime tests register actual cache owners by hash, retain two generations, and
verify old bindings survive replacement and cache destruction until release. Retired pinned outputs
remain budgeted, unchanged pinned generations remain reusable, and switching to ordinary text cannot
reuse a retired texture. Resolved temporal outputs also enter the real raster GPU capture/replay audit.
M2 G3 additionally runs a hidden GPU window for full, entering, exiting and transparent temporal
glyph exposure. These four resolved outputs use separate frozen exact PNG references, established
by comparing the pre-cycle-31 cache to its replacement on the same device. The ledger pins their
manifest; verification never regenerates them. The gate checks canonical sample counts, dimensions,
exact pixels, independent GPU resource replay and Rust resource admission. Its failure fails G3.
This closes a coverage gap in the original scene-motion-blur fixture, which disables text animators
and therefore exercises layer movement rather than temporal glyph accumulation. The original 337-case
corpus and references remain unchanged; these four output checks do not claim complete frame replay.

G1 also round-trips text/SVG/PSD scene slices built by the production geometry producer, then joins
the returned geometry with independently admitted Rust resource transcripts and binary pixels.
The original geometry and authoring scenes are discarded before the production upload and binding
consumers run. Decoded and cloned plans must upload exact vertices/pixels, retain exact bounds and
resolve the planned frame hash; missing or evicted bindings fail. These are scene-slice checks,
not evidence of complete submitted-frame replay.

Imported raster tests capture PSD crop/row layout before runtime mutation and consume it without
source reevaluation, rejecting truncated layouts before GPU writes and disposing failed allocations.
A production-cache test checks PSD descriptor publication and replaced-owner lease retention. SVG
tests bind source revisions and bucketed extents; full G3 covers the actual rasterized output.
G1 checks the synchronous descriptor hash against WebCrypto and Rust; missing hashes fail before draw.
Scene media fixtures bind those actual frame hashes to ordered draw indices, including explicit
pending output and aliases. G1 round-trips the FPLN through Rust, resolves decoded references against
an independent registry, and rejects evicted frames. GPU adapter tests additionally replay serialized
references against newly admitted physical owners after the producing owners have been destroyed.
Complete captured-frame replay remains a separate exit requirement.
G1 also sends text/SVG/PSD binary pixel fixtures to the Rust resource registry through hash-named
payload files, then admits the returned descriptors and exact bytes into an independent TS registry.
It checks exact bounds/pixels, scope enforcement and dependency eviction; corrupt bytes, absent
frames, mismatched extents and conflicting pixel generations must fail. Decoded GPU upload adapter
tests discard producer-owned bytes before replay. The production capture harness additionally
reads installed text/SVG/PSD textures, independently uploads decoded resources, and compares GPU
readbacks byte-for-byte. Hash-named binary files and source/frame/pixel messages are retained under
each case's `raster-resources/`; frame metadata lists referenced pixel hashes and case metadata binds
payload, transcript and replay checksums. Candidate publication rejects missing or altered data.
M2 G3 requires this evidence, verifies all references and all three raster origins, and submits the
actual captured binary resources to the Rust registry. Its existing 1819-frame beauty comparison
remains exact. The separate frame-artifact audit described below covers complete submitted plans.
See [Frame-plan transport](FRAME_PLAN.md) for the current contract and its explicit partial scope.

Every fresh capture saves `plan.fpln` from the actual production submission, `replay.fpln` with
installed media pixel links, `replay.rust.fpln`, `resources.json`, and `rust.json` per frame. Resource
payloads are deduplicated under each case's `frame-resources/<hash>.bin`. Before independent TS GPU
replay, `aster-render-cli ir bundle` validates the complete resource closure, round-trips nested FPLN,
and proves that attaching pixels did not alter submitted execution. The returned root FPLN drives
replay. Frame metadata binds all file hashes, the native binary and the exact production/replay
pixel comparison. Candidate publication and M2 G3 both check all captured addresses, including
sequence neighbors. Missing or changed evidence fails publication. G1 additionally proves that
missing/corrupt resources, changed execution and partial plans fail native admission without output.
The command validates transport; it does not implement native GPU rendering.

Full G3 continues to compare all required TS frames under `exact`, retaining the effective reference
set proven unchanged by completed M1. Each renderer-source change requires a fresh candidate
capture. G1 success for a transport slice does not prove complete production plan consumption or
resource replay. The M2 exit auditor runs when M2-T15 is active or completed. It binds current full
G0/G1/G3 to unchanged source, regenerated schema, exact round trips, complete captured frame coverage,
resource pin/eviction checks, and the reviewed production/supplied execution boundary. Executable
root envelopes must declare completeness; partial stages cannot. Historical failed captures remain
rejected, with their recorded disposition and a current exact comparison of the affected address.
Quick mode skips full G1 and cannot authorize a commit. All required
gates must pass in a full run before committing.

## Performance evidence

`pnpm migrate:benchmark` measures the full warm-up and three-run workload schedule described in
`docs/BENCHMARKS.md`. Scope options such as `--smoke` are diagnostic and cannot replace the baseline.
The committed local Radeon 780M series is independent of historical NVIDIA results. Missing GPU
timing or encoder capabilities remain explicit limitations, never fabricated measurements.

The original throughput baseline and separate pre-plan preview baseline remain frozen. A saved
baseline validation alone is not a measurement. The preview series runs the actual production
present path and waits for GPU completion; its scope and warm-up protocol are specified in
`docs/BENCHMARKS.md`.
The baseline-freezing command refuses to replace an existing baseline or accept measurements taken
after production planning changes.

On 2026-10-05 (Asia/Tokyo), the owner approved `owner_overrides.performance_delivery_policy`
with kind `rust-delivery-v1`. M2 requires G0/G1/G3; M4, M6 and M7 require G0/G3, with GPU timings
and other performance observations recorded when useful rather than repeatedly enforced as hard
gates. M8, M11 and M12 retain G4: native export and preview must achieve higher median FPS than
the independently retained TS program run contemporaneously on the same machine, with matched
workloads and output quality. M11 also retains its input-to-present p95 latency requirement.
Fresh measurements must bind both programs, inputs, hardware conditions and raw evidence; the
candidate cannot serve as its own reference. Native paired G4 support remains to be implemented
and verified; existing TS measurements do not satisfy that final acceptance requirement.

The old fixed-reference 5 percent limits and M8's 75/120 fps targets remain historical references,
not blocking conditions for this migration. Frozen baselines and previous failed evidence remain
unchanged, with no failed run reclassified. Pixel, quality, functional and G0 requirements remain
in force, as does the full required-gates-before-commit rule.

Display-condition changes follow the hardware manifest's existing new-series policy. An additive
1920×1080@144Hz series may use the preserved pre-plan bundle only after its complete file set and
source/bridge provenance pass the historical-bundle audit. Reference reports identify historical
renderer bytes and current common harness sources separately. They must contain complete independent
throughput and preview observations at the new conditions. Current optimized output cannot become
its own reference. The series freezer refuses overwrite; its descriptor and file hash are pinned in
the ledger before comparisons use that series. Workload, encoder, host and method pins and raw-output
checks remain part of the evidence. The former 24 fixed-reference median checks are historical
diagnostics under `rust-delivery-v1`. Historical reports cannot satisfy a fresh candidate measurement.
No previous failed run is reclassified.

Generated evidence is stored under ignored `artifacts/`; hashes and paths in the ledger identify the
actual runs. Preserve these files when continuing on the same host. A missing or modified evidence
file must fail verification rather than being accepted from a previous status string.

G1 additionally round-trips four compiled layer-effect plans, covering identity/custom LUTs,
both pyramid flags, UTF-16 identities and exact unused instruction bits. It checks supplied
uniform/program bytes and rejects undeclared LUTs. G3 requires six independent LUT/effect draws:
identity, custom LUT, adjustment, blur, glow and soft-light blend. The old effect executor is pinned
from the pre-extraction commit and its six distinct RGBA16F outputs are frozen separately under
`tests/parity/lut-draw/reference`. A fresh page/device receives only Rust-returned effect plans and
texture resource payloads; all outputs must match the frozen bytes exactly. This supplements the
full-frame corpus and does not claim full frame-plan capture or native rendering.

G1 additionally transports 19 effect execution routing slices: all blend modes, direct rendering,
root skip, precomposition zero-op adjustment, overflow, disabled effects and a deferred malformed
LUT. The routing and fusion counts survive Rust unchanged, and inconsistent composites are rejected.
The required LUT/effect GPU replay now round-trips six routing slices alongside the six compiled
programs; supplied execution decisions still match the existing frozen outputs exactly. A production
precomposition test changes authored effects/blend after planning and verifies retained execution.

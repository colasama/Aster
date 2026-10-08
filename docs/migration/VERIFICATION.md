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

## Native raster admission

M5 G3 retains the M4 native regressions and adds 20 frames across ordinary text, animated multiscript
text, SVG, merged PSD and retained PSD layer cases. Plans, resources and references remain frozen;
the native batch reuses one device and records real image-cache uploads and hits. All 20 initial
outputs are RGBA-exact and have section 6.6 self-review evidence. CPU and GPU controls also cover
typed `RasterPixels` frame identity, eviction, changed pixel generations and atomic budget rejection.
G1 retains resource transport and lifetime checks. Passing raster admission does not establish M5
exit: the complete milestone exit audit remains separate from individual supplements.

The native temporal supplement executes four frozen M2 sample sets (full exposure, enters, exits and
transparent), using their original pass bytes and sample pixels. The input manifest is pinned in the
ledger and traced to the accepted M2 exit report; reference PNGs are unchanged. GPU controls require
identical repeated output from retained targets, atomic budget rejection, rejection of wrong sample
identities and transparent output after zeroing exposure. G3 compares the resolved raster directly
to its frozen reference and requires section 6.6 self-review. Complete root reconstruction is checked
by the separate motion-frame supplement below.

The native temporal frame supplement freezes two warmed production frames with two effect-isolated
precomposition surfaces and exact independent-device TS replay. It runs cached and uncached sequences
that poison captured resolved pixels, zero exposure, change one sample and restore the original frame.
Poisoning resolved pixels must preserve output and allocations; changing actual inputs must affect
more than 16 pixels and invalidate nested effect generations. All cached outputs must equal uncached
outputs. An intervening ordinary raster releases temporal targets, and restored temporal rendering
must still match. Budget rejection and explicit skipped-surface routing publish no PNG. Original
3D-shadow captures remain preserved for their later native capability.

The root motion supplement adds all four `scene-motion-blur` corpus frames to the native raster
batch and compares six frozen production temporal frames (full, entering and exiting exposure)
against independent-device TS replay. Cached and uncached sequences must agree, clear retained
motion targets, release them on an ordinary frame and restore the original result. Zero radius and
zero vectors must each change more than 16 pixels and produce the same unblurred output. Missing
auxiliary inputs, inconsistent beauty routing and insufficient GPU budget must reject without PNGs.
Receipts expose three reconstruction passes, target reuse and resident texture bytes. These checks
exercise the shared HDR shaders before the existing display transform, without CPU frame transport.

M5 exit requires a full current G0/G1/G3 run with all six raster/motion cases and retained core/effect
regressions. The exit audit rereads frozen manifests, actual PNGs, batch jobs, CLI receipts and
comparison reports, and matches section 6.6 reviews including sequence context. It also audits
resource hash/ownership, typed raster bounds, eviction and temporal pass transport in G1; all four
standalone temporal rasters; recursive and root whole frames; changed-input controls; retained-target
release; and earlier native optimization safety evidence. Missing/stale frames or supplemental
checks fail the exit even when a summary flag says passed. Native raster execution completes this
phase; shaping, video decode and production preview/export integration remain separate milestones.

## Native geometry, blend and supplied-image acceptance

M3 G3 executes the current release `aster-render-cli render-plan` against complete captured FPLN
bundles and their hash-pinned resource closure. The complete core scope covers 36 cases (145 frames):
solid/vector geometry, every blend mode, off/FXAA/SSAA2x/SSAA4x, supplied PNG/JPEG images, masks,
mattes, adjustments and recursive precomposition surfaces. Each receipt binds the native
adapter, plan hash, dimensions and decoded PNG pixels. Comparisons use the independently frozen
TS references under the specified `gpu` profile, including every structural check and recorded
section 6.6 self-review. M1/M2 retain their separate whole-corpus `exact` requirements.

The gate also checks rejection without output publication for unsupported features, allocation
budgets and corrupt resources, and preserves pre-existing output. Binary and input hashes must
remain stable throughout the run. Core coverage includes parented transforms, captured cloner
geometry, ellipse/rectangle effect masks and the existing path-mask schema case. `full_coverage`
is scoped to M3, not the entire migration corpus. The M3 exit auditor independently rereads every
actual native output, execution receipt, comparison and matching self-review. It rejects missing,
duplicate, stale or inconsistent evidence, and requires all three GPU cache/HDR tests and every
capability/resource rejection. G0/G1/G3 must pass together against unchanged source.

Supplied-image receipts require actual native texture uploads and report `native_image_decode: false`.
Supplied pixel hashes are bound to matching frame
descriptors and scene/root draw references before allocation. An ignored GPU test, run by G3,
checks repeated texture reuse, distinct pixel generations for one frame, current-frame eviction
protection, budget shrink and unchanged cache state after rejected input or insufficient budget.

A separate native-still subgate renders eight PNG/JPEG frames from original FPLN without captured
pixels. It materializes hash-pinned source files, grants each source and scope explicitly, and checks
native decode receipts plus the same frozen-reference GPU comparisons and self-reviews. Missing
grants, incorrect scopes/hashes and source/pixel budget violations must reject without publication.
The packaged FFmpeg executable and all source inputs are pinned for the run. These eight renders
supplement the 145 supplied-resource frames.

EXR has the recorded `ts-exr-import` reference boundary. G0 checks the real hash-pinned EXR asset's
linear sample values and rejects malformed extents, budgets and non-finite values. G1 round-trips
the additive `rgba16float` media descriptor. G3 also decodes an authorized HDR EXR file and runs the
production image shader through the actual float texture cache: associated `(4, -2, 0.25, 0.5)` must
survive exactly, proving that values were neither clipped to SDR nor sampled as sRGB. Float texture
budget rejection and reuse are checked on the GPU. A supplemental EXR frame-plan run replaces only
the captured image resource closure and records its native receipt and output; its report explicitly
does not claim unavailable TS EXR pixel parity. No frozen references or tolerances are modified.

The native layer increment adds all four frames of the three mask/matte scenes and the adjustment
layer case. These execute original supplied operation bytes, fixed alpha composition and scene
replacement on DX12, using the existing Electron DXC library with its hash recorded in G3. The
library is an explicit CLI input, never inferred from the frame plan. Every result uses the frozen
TS reference and the same GPU structural checks and self-review. Unsupported effect operations
outside the admitted native subset still reject. The full M3 exit additionally requires all core cases and its independent audit.

The recursive-surface increment additionally runs all eight original nested-precomposition and
nested-adjustment frames, including the captured blur/glow dependencies. Receipts require real GPU
surface allocations. G3 runs a GPU cache test for whole-set admission, unchanged state on rejected
budgets/dimensions, exact-identity hits, compatible-allocation reassignment, dimension changes and
retirement after shrink. Child-first routes are cross-checked with each captured geometry mapping.
Surface pixels remain linear and premultiplied until the root display pass. No pre-rendered child
pixels replace native child-scene execution.

Core acceptance preserves three reference boundaries: EXR uses native linear-sample and GPU proof
because TS cannot import it; the path-mask schema case retains the TS ellipse fallback; the
minimal golden animation is hidden by its opaque background. Animated parented transforms and
cloner geometry have separate visible cases. Native evaluation and native cloner generation remain
later milestones. M3 completion does not switch production preview/export away from TS.

## Native effect increments

M4 G3 retains the complete 145-frame M3 regression scope and adds 1087 frames across 271
captured effect and layer-style cases, including color, tone, distortion, temporal effects,
individual layer styles and LUTs. The explicit admission list is checked against the frozen corpus;
a new or omitted effect case fails coverage validation. This gives 1232 native replay frames. The eight LUT frames (`effect-lut` trilinear and
`lut-tetrahedral`) each require a real native LUT upload and resident
bytes, frozen-reference GPU comparisons and section 6.6 self-review. Root and recursive layer
programs bind their captured LUT hash, preserving the shared shader's interpolation and domain
semantics. A GPU test verifies exact half-float upload (including negative/HDR values), repeated
hits, whole-demand budget rejection without mutation, protected current entries and eviction under
budget shrink. G0 rejects invalid shapes and non-finite samples. The former LUT unsupported-feature
probe is replaced by the still-unsupported lighting route.

M4 increments report incomplete milestone coverage until every registered effect, layer style and
required native optimization has evidence. Passing this effect increment does not claim M4 completion
or switch the production preview/export path.

The diagnostic `render-plan --batch <jobs.json>` command accepts a bounded JSON array of
`{plan, resources, resource_manifest?, out}` jobs. It retains one native device, pipelines and GPU
caches across frames, but validates each supplied plan and resource closure independently. Outputs
must be unique absolute paths that do not already exist. Each PNG is published atomically, followed
by a receipt with its plan/pixel hashes, zero-based `frame_index` and `renderer_reused` flag. A later
invalid frame fails the command while preserving complete prior frames and leaving no failed-frame
PNG. G3 verifies all 1087 effect receipts, 1086 device reuses, duplicate/limit rejection and partial-failure
output integrity. This diagnostic readback path is not the production export pipeline.

Known shared integer effect opcodes are admitted without rewriting the supplied program. Unknown,
non-finite or fractional codes still fail; pyramid-dependent base blur/glow remain unsupported.
The 271-case scope proves supplied fused-program parity at the captured parameters, including the
six-operation combined layer-style chain. The production layer and root plan builders supply neutral
base parameters; user adjustments are compiled into effect operations. Native execution preserves
those uniforms. Arbitrary non-default legacy base blur/glow controls are not accepted by this proof.
Native optimizations require separate evidence before M4 exit. The color-range and twister fixtures are transparent in both
reference and candidate, so their acceptance does not prove nonempty behavior. Repeated frames
within each LUT case must increase cache hits without another upload; this check is independent
of the case position in the batch.

Native blur/glow pyramids use radius-bounded mip counts for allocation, transient admission and
per-layer recording. The radius audit covers every shared shader operation that samples a pyramid,
including channel maxima, compound blur bounds and signed bokeh CoC. Non-finite or unknown data
keeps full counts; shader operation admission still rejects unsupported programs. A guard mip
preserves interpolation and LOD rounding, and supplied max-LOD uniforms are unchanged. A native-only
two-target seed pass shares source taps when both chains are needed while preserving bright-pass
ordering; subsequent levels remain independent. Optimization comparisons must match the old native
compiler selection as well as the plan, adapter and pixels: early core cases use the default compiler,
whereas effects and later core routes use the pinned DXC. Matching the whole currently executable
1232-frame native scope does not establish support for later milestones' cases.

M4 additionally requires two native surface-post replays against the separately frozen M2 output
fixtures: selection isolation and vector motion blur. Extracted FPLN controls and HDR/object-ID/motion
attachments are pinned under `tests/parity/native-surface-post`; their original complete input JSON
hashes matched the frozen output manifest before extraction. A retained native GPU pipeline consumes
these supplied controls. G3 checks pixels, structural metrics and matching self-review records, while
the GPU test also proves control mutations change output, captured skips preserve the destination,
invalid attachment formats fail before writes, and replay restores identical pixels. These two
supplemental outputs are separate from the 1232 whole-frame corpus replays. Complete-frame surface
routing is verified separately below.

G3 also requires six native primary-auxiliary replays, comparing all five MRT attachments byte for
byte with the frozen M2 auxiliary references. The supplied scene, ID and motion plans are pinned in
`tests/parity/native-auxiliary-primary`; alpha-tested media and precomposition bindings retain their
captured inputs. Checks cover ID changes including `u32::MAX`, omitted draws, alpha texture removal,
motion removal, exact replay restoration, budget rejection and clearing previously drawn targets.
Only the primary normal/ID/world-position/motion attachments are claimed for higher-tier fixtures;
transparency aggregation, front color, depth peeling and generator execution remain pending.

Sixteen complete native surface frames cover selection isolation and vector motion blur with AA off,
FXAA, SSAA2x and SSAA4x, each with ready and skipped plans. The added reference set combines frozen
production geometry with explicit surface controls and a nonzero output clear; two independent TS
GPU devices produced identical reference frames. G3 runs all plans on one retained native device,
checks receipt identity, compares pixels and requires matching self-review records. Skipped frames
follow ready frames to expose stale targets. Admission tests reject mismatched modes, frame headers,
draw ranges and missing ready attachments before GPU recording; skipped plans without attachments
remain valid. Existing whole-frame and supplemental references are unchanged.


The native layer-cache gate replays all 1232 current corpus frames and sixteen complete surface
frames with caching disabled, with immediate repeated frames on retained devices, and with both
caching and effect-region scissors disabled. All 4992 outputs must match the normal native receipt's RGBA hash exactly, and at least one retained output
must be reused. Compiler selection matches each case's existing native path. Disabled runs must
allocate no layer cache; enabled residency must stay within the explicit 64 MiB limit. This compares
the optimization to uncached native execution in addition to G3's unchanged TS reference comparisons.
GPU controls also check cross-time reuse, current-backdrop compositing, changed-effect invalidation,
cache and total-budget pressure, retained generations, and abandoned encoder copies. Three nested
GPU scenes prove descendant changes invalidate parent outputs and match uncached rendering. CPU
tests check geometry, lighting, LUT, media generation, aliases, clear/load semantics and recursive
time dependencies. A shared-WGSL consumer audit pins every opcode that reads or changes effect time;
unknown revisions retain the clock. Tint, LUT and combined layer-style replays must actually admit and
reuse their precomposition inputs. Adjustments and dependencies with unknown history remain
ineligible for result reuse.

Region comparisons must demonstrate a positive reduction in drawn pixel area with the cache disabled;
full-region controls must report zero bounded passes and equal full/drawn areas. GPU fixtures compare
padded outer glow and stroke against full-frame output at fractional geometry edges, then move the
geometry offscreen to prove empty regions clear correctly. CPU controls cover conservative padding,
unproved warps, non-neutral base settings and non-finite vertices. This admission intentionally keeps
spatial programs with unproved footprints full-frame; a surface quad spanning the viewport remains
full-frame even if its child texture contains transparent areas.

The SSAA effect-resolution safety control evaluates blur and outer glow at output resolution under
SSAA2x and SSAA4x, then bilinearly reconstructs their RGBA16Float results before the unchanged display
and AA passes. It retains the high-resolution geometry, source sampling, radii and blur pyramid.
Each full-resolution control must first match actual native renderer bytes. All four reduced-grid
comparisons exceed the hard maximum error of 8; three also exceed alpha coverage limits. Direct
contact-sheet and heatmap reviews reject the strategy. It exists only in GPU tests, and the production
renderer keeps full-resolution effects. G3 requires the expected rejection and matching ledger
self-reviews; its successful safety-control status does not mean reduced-resolution pixels passed.
No tolerance is loosened. This rejects the tested RGBA resampling strategy, not every possible
future decomposition that could preserve high-resolution alpha and demonstrate whole-corpus parity.

The M4 exit audit runs when `M4-T6` is active or M4 is already done. It requires all earlier M4 tasks,
current full G0/G3, and exact coverage of the frozen catalog's effect/style frames plus retained core
regressions. Corpus coverage tests bind the catalog to `EFFECT_REGISTRY`; additions cannot silently
inherit native admission. The audit reopens FPLN inputs, native PNGs, single-frame and batch receipts,
pixel reports, frozen references and matching self-reviews. It also audits sixteen complete surface
frames, two standalone surface effects, thirty primary auxiliary attachments, all 4992 cache/region
outputs and the four rejected SSAA experiments. Missing, duplicated, stale or substituted evidence
prevents milestone completion. Coverage is scoped to M4; text rasters, native video, higher-tier 3D,
export, native evaluation and production preview remain later milestones.

Native media increments retain the M5 raster/effect/cache regressions. The image-sequence gate uses
original plans without supplied pixels, explicit per-member authorizations and the packaged FFmpeg
snapshot decoder. Twelve frozen hold-boundary and frame-identity outputs are compared through the
corpus pixel gate; twelve reverse requests must reproduce them exactly without extra GPU uploads.
Missing/scope/member/byte-identity and allocation failures must publish no PNG. Sequence coverage
alone never establishes M6 completion: exact video timing, integration and the media exit audit remain
required.

The native video gate decodes all 44 fractional-rate and seek-boundary corpus frames from original
plans and explicit source grants. Each receipt must identify the expected presentation frame and
rational timestamp, retain source color metadata, and report CPU upload honestly. `decode` metrics,
structural checks and neighboring-frame identity are reviewed independently. Timestamp mismatch and
out-of-duration controls reject before publishing; an intentionally selected neighboring frame must
fail the pixel oracle. Source/pixel/index budgets and timeout controls remain required. These checks
do not establish production routing.

The video gate also checks 148 exact output comparisons across retained forward/reverse requests,
disabled decode caching, pixel-byte pressure and entry-count pressure. Every receipt must match the
original frame's source, selected timestamp, decoded hash and GPU output; cache counters must match
the requested identities and LRU limits. Sequence batches similarly require one decode per distinct
member identity and reuse for held/reversed frames. In-process EXR tests verify cancellation before
a cache hit, reuse of verified bytes after source removal, fresh authorization across job boundaries,
and renewed source access after either budget evicts the frame. This proves bounded decoded-frame
reuse; it does not claim a persistent streaming video codec or GPU decode interop.

Mixed-media inputs are independently captured through the production TS renderer and replayed exactly
on another device before freezing under `tests/parity/native-media-frame`. Six frames cover root and
two-level recursive scenes containing PNG, fractional-rate video and eight-sample temporal text at
forward/backward times. Capture requires visible alpha coverage and changing pixels; an empty
recursive fixture cannot pass merely because both renderers produced transparent output. Native
plans retain only raster pixel attachments and decode file media from SHA-256-bound grants. G3 checks
the active capture adapter, complete immutable resource closure, native decode receipts, temporal
execution, `decode` metrics/structural checks, sequence identity and full section 6.6 review evidence.
Root and recursive replay payloads containing supplied file-media pixels must be rejected without
publishing a PNG. The initial off-canvas fixture and failed comparison remain in the cycle evidence.

The M6 exit audit runs when `M6-T4` is active or M6 is already done. It requires current full G0/G3,
all earlier media tasks, all 12 sequence and 44 video corpus frames, and six frozen mixed scenes.
It rereads native batch logs, authorized snapshots, original plans, output PNGs, comparison reports
and matching self-reviews. Exact rational frame identity, color metadata, reverse/held sequence
pixels, 148 cache comparisons and independently recomputed LRU counters must agree with execution.
Authorization, budget, timeout, invalid-time and supplied-file-pixel controls must reject without
output; a neighboring video frame must fail the pixel oracle. Private snapshot directories must be
empty. Earlier core, effect, raster and GPU cache regressions are audited in the same run. Missing,
stale, duplicated or inconsistent evidence prevents completion even if a summary says passed.
This acceptance covers FFmpeg snapshot decode and GPU upload; streaming codec state, optional
hardware surface interop and production preview/export routing remain separate work.

M7 begins with twenty frozen orthographic/perspective camera and depth-of-field frames. Native
execution uses the captured shadow-map size and geometry, primary auxiliary MRT, front-color,
transparent aggregate and second-layer peel passes before shared depth shading. Receipts require
five depth passes and matching retained target reuse. Additional requests switch to ordinary beauty,
back to depth and then repeat; they must retire, rebuild and reuse the depth allocation while
reproducing the corresponding pixels exactly. An insufficient whole-frame GPU budget rejects without
output. All frames enter the existing pixel/self-review gate and cached/uncached regression batches.
This increment does not establish complete M7 coverage: material lighting, generators and recursive
scene integration retain explicit ledger tasks.

An independent scene-output capture supplements the frozen corpus with sixty-four complete frames:
overlapping translucent camera geometry, K0/K1/K2 depth with and without motion reconstruction,
depth fog, an explicit skipped-depth clear, and eight diagnostic views across all four AA modes.
Two independent TS devices must agree exactly. Sixteen paired controls require depth tier, motion
and skipped-output changes to alter visible pixels. Capture runs separately from native comparison;
its plan, resource and reference hashes are pinned in the ledger. Native cached/uncached batches
must agree exactly, report expected depth and motion passes, and release inactive targets. Each
output passes the GPU pixel profile and self-review; insufficient whole-frame memory rejects with
no output. Floating auxiliary views use the supplied render extent for their range; integer ID views
use real integer attachments rather than converting IDs to floats.

Material coverage adds the twelve frozen directional/point/spot frames and sixty independently
captured supplied mesh frames across all AA modes. Actual RGBA16F environments exercise intensity,
rotation, content generation changes and inactive fallback. Forty-four paired reference controls
require visible differences, including directional and spot shadow disable controls that change
both the pass flag and the lighting sampler flag. Two independent TS devices must agree before
references are pinned. Native batches require exact cache-on/cache-off output, two texture uploads
with later reuse, bounded resident bytes, GPU-profile pixels and self-review. Point shadows remain
the existing TS unsupported boundary.

Inline normal-map coverage captures 144 complete TS frames on two independent devices: three
lights, four AA modes, PNG/JPEG/WebP, positive/negative/zero scale and combined HDR. The native gate
requires all 144 frames under the unchanged GPU profile, exact cached/uncached output, exact
decoded texture hashes, and native decode/cache receipts. Windows JPEG normals use the built-in
Microsoft WIC decoder, whose pixels match the browser oracle. Earlier FFmpeg JPEG rounding
amplified to unacceptable material shading error; its failed evidence remains rejected. Other
platforms still reject JPEG normals. Another 24 independently repeated TS material frames cover
animated WebP first images: full and offset subframes, blend/replace flags, transparent canvas,
normal/zero scale and all four AA modes. Twelve controls establish visible normal-map influence.
`tests/parity/assets/animated-normal-textures.json` pins exact decoded bytes, which ignore the
opaque animation background and later red frame. The native adapter copies the decoded first
subframe onto a transparent canvas to avoid animated source-over rounding of opaque pixels.
Cached and uncached rendering must remain exact, with three decoded and GPU generations retained
under their byte budgets.
Dimension, chunk-boundary, cancelled-cache and allocation controls reject invalid inputs before
publication. `tests/parity/assets/normal-textures.json` preserves independently captured linear
texture bytes, including fractional and zero alpha. `image-webp` 0.2.4 (MIT OR Apache-2.0) replaces
FFmpeg WebP color conversion because its bilinear reconstruction matches the browser texture oracle;
the shipped FFmpeg build and source authorization contract are unchanged. WIC uses the existing
locked Windows bindings and the operating-system codec; it adds no bundled native codec library.

Root particle coverage executes twelve frozen billboard, mesh and streak frames at four supplied
rational times. The unchanged GPU profile includes sequence-neighbor identity checks and section
6.6 review. Native generator positions are marked invariant during Naga compilation: unrestricted
arithmetic reassociation lost one thin streak pixel despite matching nearly the entire image.
The failed pre-invariance comparison remains recorded. Cached/uncached and bounded/unbounded
effect-region runs must remain byte-identical, and a generator allocation-budget control must
reject before publishing output. Unit controls reject mismatched frame identity, realization,
missing/duplicate invocations and invalid shader text.

Fifteen frozen bars, ring and oscilloscope frames now exercise supplied root-time audio analysis in
the native generator graph. GPU controls silence the audio samples, add a visible sibling, omit
that sibling's redundant audio payload, restore the original frame and reject contradictory audio
records before output publication. Shared and inherited audio must produce identical pixels,
restored frames must match the frozen-input native baseline exactly, and both silence and a new
sibling must visibly change the image. The audio record is budgeted once per root frame. These checks
cover root beauty output.

Generator output references independently route frozen invocations through five auxiliary views,
unblurred beauty, motion reconstruction, K2 depth of field and an omitted-auxiliary control across four AA modes.
The 216 complete frames cover billboard, mesh, streak, bars, ring and scope. Two independent TS
devices must agree exactly before the reference manifest is pinned. Twenty-four particle controls prove
that auxiliary geometry and motion reconstruction change the image; the three beauty-only audio variants must retain the
same empty auxiliary result when no descriptor exists. Native cached and uncached outputs must agree
exactly, release motion/depth targets between routes, and pass pixel and structural self-review.

Case-specific peak-error adjustments live in the embedded `tests/parity/tolerance-overrides.json`
catalog and in the migration ledger. Only a matching case/profile may use one. The comparator caps
peak error at eight, enforces SSIM at least 0.995 and PSNR at least 40 dB, and preserves stricter base
limits and all structural limits. Exact comparisons cannot be relaxed. The billboard FXAA motion
case permits a peak of seven after review of two sparse edge pixels; its default mean/PSNR limits
remain unchanged. Native normalization uses vector/length division to avoid a one-ULP particle
position difference changing mesh raster coverage; no diagnostic particle readback remains.

Recursive generator integration uses 108 independently captured complete frames across six bundled
variants and four AA modes. Child-only, two-level child-first surfaces and captured unavailability
exercise routing through the retained root effect. Audio variants additionally compare explicit
shared input, inherited root input and silence. Thirty-six observable controls prove generator and
audio contributions; twelve conflicting root/child records must fail without publishing pixels.
Cached and uncached renders must match exactly, including three restored audio frames after other
scenes and silence. The pixel gate authenticates all inputs, resources and self-review hashes.
Post-fragment product boundaries preserve rounding before display conversion and FXAA. The native
lowering is restricted to the fragment entry; shader helper functions remain unchanged. Existing
corpus and output routes are rechecked against their frozen references after this lowering changes.

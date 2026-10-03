import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { digest } from "../parity/provenance.mjs";
import { performanceEligibility } from "./eligibility.mjs";
import { validatePerformanceResult, validateProbe } from "./output-session.mjs";
import { summarizePerformance } from "./statistics.mjs";

function safePath(value) {
  assert(
    typeof value === "string" &&
      /^[a-zA-Z0-9._/-]+$/.test(value) &&
      !isAbsolute(value) &&
      !value.split("/").some((part) => !part || part === "." || part === ".."),
    "Unsafe baseline evidence path",
  );
  return value;
}

function sha(value) {
  assert(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "Missing or malformed baseline SHA-256",
  );
  return value;
}

/** Validates committed observations only; never opens private project assets or ignored MP4 files. */
export async function validateCommittedBaseline(root) {
  const base = await realpath(root);
  const snapshots = new Map();
  const json = async (name, expected) => {
    const path = await realpath(resolve(base, safePath(name)));
    const member = relative(base, path);
    assert(
      member && member !== ".." && !member.startsWith(`..${sep}`) && !isAbsolute(member),
      "Baseline evidence escapes the checkout",
    );
    const bytes = await readFile(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (expected !== undefined)
      assert.equal(hash, sha(expected), `Baseline evidence SHA-256 mismatch: ${name}`);
    snapshots.set(path, hash);
    return JSON.parse(bytes.toString("utf8"));
  };
  const baseline = await json("benchmarks/results/migration-baseline.json");
  assert.equal(baseline.schema_version, 1);
  assert.equal(baseline.status, "passed");
  assert.equal(baseline.baseline_eligible, true);
  assert.equal(baseline.source_unchanged, true);
  assert.equal(baseline.hardware_unchanged, true);
  safePath(baseline.evidence.report);
  sha(baseline.evidence.sha256);
  const source = await json(baseline.evidence.source, sha(baseline.evidence.source_sha256));
  assert.deepEqual(source.before, source.after, "Saved source changed during measurements");
  for (const field of [
    "commit",
    "branch",
    "dirty",
    "tree_sha256",
    "renderer_source_sha256",
    "bridge_sha256",
  ])
    assert.deepEqual(
      source.before[field],
      baseline.source[field],
      `Saved source identity differs: ${field}`,
    );
  for (const key of ["tree_sha256", "renderer_source_sha256", "bridge_sha256"])
    sha(source.before[key]);
  assert(Array.isArray(source.before.files) && source.before.files.length > 0);
  const sourcePaths = new Set();
  for (const file of source.before.files) {
    safePath(file.path);
    sha(file.sha256);
    assert(!sourcePaths.has(file.path), "Duplicate captured source path");
    sourcePaths.add(file.path);
  }
  assert.equal(
    digest({ files: source.before.files, bridge_sha256: source.before.bridge_sha256 }),
    source.before.renderer_source_sha256,
  );
  const manifest = await json(baseline.hardware_manifest);
  assert.equal(
    digest(manifest),
    sha(baseline.hardware_manifest_sha256),
    "Hardware manifest digest changed",
  );
  assert.equal(baseline.series, manifest.id);
  for (const binary of ["ffmpeg", "ffprobe"]) {
    sha(baseline.ffmpeg_sha256[binary]);
    assert.equal(baseline.ffmpeg_sha256[binary], baseline.ffmpeg_sha256_after[binary]);
  }
  const expected = new Map();
  for (const [id, start, end, width, height] of [
    ["owner-opening", 0, 714, 1920, 1080],
    ["owner-main", 714, 1014, 1920, 1080],
    ["composite-1080p", 0, 600, 1920, 1080],
    ["composite-4k", 0, 600, 3840, 2160],
    ["effect-chain-1080p", 0, 600, 1920, 1080],
  ]) {
    for (const mode of id.startsWith("owner-")
      ? ["readback-only", "ipc-no-encode", "full-mp4"]
      : ["readback-only"])
      expected.set(`${id}/${mode}`, { id, mode, start, end, size: { width, height } });
  }
  assert.equal(
    baseline.measurements.length,
    expected.size,
    "Required performance group is missing",
  );
  const seen = new Set();
  const caseInputs = new Map();
  const diagnostics = [];
  let measuredFrames = 0;
  for (const measurement of baseline.measurements) {
    const key = `${measurement.case_id}/${measurement.mode}`;
    const spec = expected.get(key);
    assert(spec && !seen.has(key), "Unknown or duplicate performance group");
    seen.add(key);
    const raw = await json(measurement.raw_data, sha(measurement.raw_data_sha256));
    assert(
      Array.isArray(raw) && raw.length === 4,
      "Every group needs warm-up and three measured runs",
    );
    assert.deepEqual(raw.map((entry) => entry.benchmark.run).sort(), [0, 1, 2, 3]);
    const assignments = [];
    for (const entry of raw) {
      assert.equal(entry.status, "passed");
      assert.equal(entry.caseId, spec.id);
      assert.equal(entry.case_hash, digest(entry.inputs), "Saved case input hash differs");
      const item = entry.inputs.case;
      assert.equal(item.id, spec.id);
      assert.deepEqual(item.size, spec.size);
      const frames = Array.from(
        { length: spec.end - spec.start },
        (_, index) => spec.start + index,
      );
      assert.deepEqual(item.frames, frames, "Pinned workload frame domain changed");
      assert.deepEqual(entry.inputs.frames, frames);
      if (caseInputs.has(spec.id)) assert.deepEqual(entry.inputs, caseInputs.get(spec.id));
      else caseInputs.set(spec.id, entry.inputs);
      const benchmark = {
        id: `${spec.id}-${spec.mode}-${entry.benchmark.run}`,
        mode: spec.mode,
        requireAudio: spec.mode === "full-mp4",
        run: entry.benchmark.run,
        frameRate: { numerator: 30, denominator: 1 },
        warmupFrames: 10,
        startFrame: spec.start,
        endFrameExclusive: entry.benchmark.run === 0 ? spec.start + 10 : spec.end,
      };
      assert.deepEqual(entry.benchmark, benchmark, "Pinned benchmark configuration changed");
      assert.equal(entry.id, benchmark.id);
      const assignment = { case: item, benchmark };
      assignments.push(assignment);
      validatePerformanceResult(
        assignment,
        entry.result,
        entry.output,
        baseline.host.webgpuAdapter,
      );
      assert.equal(entry.output.mode, spec.mode);
      diagnostics.push(entry.result.diagnostics);
      if (benchmark.run > 0) measuredFrames += entry.result.frames;
      if (spec.mode === "full-mp4") {
        const { result, output } = entry;
        assert.equal(typeof output.encoder, "string");
        assert.equal(output.encoder, output.encoderReport.encoder);
        assert.equal(output.encoderReport.frameCount, result.frames);
        assert.equal(output.encoderReport.audioFrameCount, result.audio.frameCount);
        assert.equal(output.encoderReport.bytesWritten, output.ffprobe.bytes);
        sha(output.ffprobe.sha256);
        validateProbe(output.ffprobe.result, {
          width: result.width,
          height: result.height,
          frameRateNumerator: result.frameRate.numerator,
          frameRateDenominator: result.frameRate.denominator,
          frameCount: result.frames,
          audio: result.audio,
        });
      } else assert.equal(entry.output.ffprobe, null);
    }
    const { raw_data: _path, raw_data_sha256: _hash, ...summary } = measurement;
    assert.deepEqual(
      summarizePerformance(raw, assignments, false),
      [summary],
      `Saved timing summary differs: ${key}`,
    );
  }
  const expectedFrames = [...expected.values()].reduce(
    (count, item) => count + (item.end - item.start) * 3,
    0,
  );
  assert.equal(measuredFrames, expectedFrames);
  assert.equal(baseline.measured_frame_count, expectedFrames);
  assert.equal(baseline.warmup_suite_run_count, expected.size);
  const eligibility = performanceEligibility({
    hardware: baseline.hardware,
    hardwareAfter: baseline.hardware_after,
    host: { backend: baseline.host.backend, native_backend: null, cacheIdentity: baseline.host },
    diagnostics,
    manifest,
    sourceUnchanged: baseline.source_unchanged,
    hardwareUnchanged: baseline.hardware_unchanged,
    diagnostic: false,
    skipped: baseline.skipped,
  });
  assert.equal(eligibility.eligible, true, eligibility.reasons.join(", "));
  assert.deepEqual(
    eligibility,
    baseline.eligibility,
    "Saved eligibility differs from its evidence",
  );
  for (const [path, expectedHash] of snapshots)
    assert.equal(
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
      expectedHash,
      "Baseline input changed during validation",
    );
  return {
    status: "passed",
    series: baseline.series,
    groups: expected.size,
    runs: diagnostics.length,
    measured_frames: measuredFrames,
    warmup_runs: expected.size,
  };
}

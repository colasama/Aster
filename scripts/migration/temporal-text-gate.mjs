import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { loadIrRuntime } from "./ir-gate-runtime.mjs";
import { auditTemporalPassReplay } from "./temporal-pass-capture.mjs";
import { validateTemporalOutput } from "./temporal-text-evidence.mjs";

/** Required M2 GPU coverage for glyph-local shutter samples, absent from the legacy corpus. */
export async function auditTemporalText(reader, context, execute) {
  const prefix = "tests/parity/temporal-text/reference";
  const ledger = await reader.json("docs/migration/rust-renderer-progress.json");
  const frozen = ledger.reference_baseline.temporal_text;
  assert.equal(frozen.path, `${prefix}/manifest.json`);
  const reference = await reader.json(frozen.path, frozen.sha256);
  assert.equal(reference.reference_commit, frozen.reference_commit);
  assert.equal(reference.profile, "exact");
  assert.deepEqual(
    reference.cases.map((r) => r.mode),
    ["full", "enters", "exits", "transparent"],
  );
  const output = join(context.output, "temporal-text");
  const run = await execute(
    {
      id: "temporal-text-gpu",
      file: "node",
      args: ["scripts/migration/temporal-text-runner.mjs", output],
      timeout_ms: 180_000,
    },
    context,
  );
  assert.equal(run.status, "passed", "Temporal text GPU execution failed");
  const logical = relative(context.root, output).replaceAll("\\", "/");
  const gpu = await reader.json(`${logical}/gpu.json`);
  assert.equal(gpu.status, "passed");
  assert.equal(gpu.results.length, reference.cases.length);
  assert.deepEqual(
    gpu.frame_replays.map((item) => item.mode),
    ["full", "enters", "exits"],
  );
  assert(
    gpu.frame_replays.every(
      (item) =>
        item.frames.length === 2 &&
        item.frames.every(
          (f) =>
            f.exact &&
            f.changed_pixels > 16 &&
            f.independent_device &&
            f.warmed_cache &&
            f.passes > 0 &&
            f.samples > 0 &&
            f.bytes === 230400,
        ),
    ),
  );
  const results = [];
  const transcript = [];
  assert.equal(gpu.pass_replays.length, reference.cases.length);
  const runtime = await loadIrRuntime(context.root);
  try {
    for (let index = 0; index < reference.cases.length; index++) {
      const expected = reference.cases[index];
      const actual = gpu.results[index];
      assert(/^[a-f0-9]{64}$/.test(actual.pixel_hash));
      const path = `${logical}/payloads/${actual.pixel_hash}`;
      const pixels = await reader.bytes(`${path}.bin`, actual.pixels_sha256);
      const replay = await reader.bytes(`${path}.replay.bin`, actual.replay_sha256);
      const messages = await reader.json(`${path}.json`);
      const png = await reader.bytes(`${prefix}/${expected.path}`, expected.png_sha256);
      const checked = validateTemporalOutput(
        { ...actual, pixels: pixels.bytes, replay: replay.bytes, messages },
        expected,
        png.bytes,
      );
      assert.deepEqual(checked, actual);
      results.push(checked);
      transcript.push(...messages);
      assert.equal(gpu.pass_replays[index].mode, expected.mode);
      await auditTemporalPassReplay(
        reader,
        logical,
        runtime,
        gpu.pass_replays[index],
        checked,
        pixels,
        transcript,
      );
    }
  } finally {
    await runtime.close();
  }
  assert.deepEqual(await reader.json(`${logical}/resources.input.json`), transcript);
  const cli = join(
    context.root,
    "target",
    "release",
    `aster-render-cli${process.platform === "win32" ? ".exe" : ""}`,
  );
  const rust = await execute(
    {
      id: "temporal-text-resources",
      file: cli,
      args: [
        "ir",
        "resources",
        "--input",
        join(output, "resources.input.json"),
        "--output",
        join(output, "resources.output.json"),
        "--payloads",
        join(output, "payloads"),
      ],
    },
    context,
  );
  assert.equal(rust.status, "passed", "Rust rejected temporal GPU resources");
  assert.deepEqual(await reader.json(`${logical}/resources.output.json`), transcript);
  return {
    status: "passed",
    profile: "exact",
    adapter: gpu.adapter,
    results,
    pass_replays: gpu.pass_replays,
    frame_replays: gpu.frame_replays,
    reference: `${prefix}/manifest.json`,
    report: `${logical}/gpu.json`,
    rust_messages: transcript.length,
    duration_ms: run.duration_ms + rust.duration_ms,
  };
}

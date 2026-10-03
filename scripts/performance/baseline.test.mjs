import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { validateCommittedBaseline } from "./baseline.mjs";

const repository = resolve(import.meta.dirname, "../..");
const baselinePath = "benchmarks/results/migration-baseline.json";
const read = async (root, path) => JSON.parse(await readFile(join(root, path), "utf8"));
const write = async (root, path, data) => writeFile(join(root, path), `${JSON.stringify(data)}\n`);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "aster-baseline-audit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const baseline = await read(repository, baselinePath);
  for (const path of [
    baselinePath,
    baseline.hardware_manifest,
    baseline.evidence.source,
    ...baseline.measurements.map((item) => item.raw_data),
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await copyFile(join(repository, path), join(root, path));
  }
  return { root, baseline };
}

async function modifyRaw(root, baseline, index, mutate, rebind = true) {
  const measurement = baseline.measurements[index];
  const raw = await read(root, measurement.raw_data);
  mutate(raw);
  await write(root, measurement.raw_data, raw);
  if (rebind) {
    measurement.raw_data_sha256 = createHash("sha256")
      .update(await readFile(join(root, measurement.raw_data)))
      .digest("hex");
    await write(root, baselinePath, baseline);
  }
}

test("saved baseline validates offline without private assets or exported MP4 files", async (t) => {
  const { root } = await fixture(t);
  assert.deepEqual(await validateCommittedBaseline(root), {
    status: "passed",
    series: "windows-radeon780m-local",
    groups: 9,
    runs: 36,
    measured_frames: 14526,
    warmup_runs: 9,
  });
});

test("altered summaries, raw samples and source hashes fail independently", async (t) => {
  for (const scenario of ["summary", "sample-hash", "sample-rebound", "source"]) {
    const { root, baseline } = await fixture(t);
    if (scenario === "summary") {
      baseline.measurements[0].fps.median += 1;
      await write(root, baselinePath, baseline);
    } else if (scenario === "source") {
      baseline.evidence.source_sha256 = "f".repeat(64);
      await write(root, baselinePath, baseline);
    } else {
      await modifyRaw(
        root,
        baseline,
        0,
        (raw) => {
          raw[1].result.readbackWallLatenciesMs[0] += 100000;
        },
        scenario === "sample-rebound",
      );
    }
    await assert.rejects(validateCommittedBaseline(root), /SHA-256|timing summary differs/);
  }
});

test("missing cases, warm-up, frame samples and malformed probe evidence cannot pass", async (t) => {
  for (const scenario of ["case", "warmup", "frame", "probe", "path"]) {
    const { root, baseline } = await fixture(t);
    if (scenario === "case") baseline.measurements.pop();
    if (scenario === "path") baseline.measurements[0].raw_data = "../outside.json";
    if (scenario === "case" || scenario === "path") await write(root, baselinePath, baseline);
    else {
      const index =
        scenario === "probe"
          ? baseline.measurements.findIndex((item) => item.mode === "full-mp4")
          : 0;
      await modifyRaw(root, baseline, index, (raw) => {
        if (scenario === "warmup") raw.shift();
        if (scenario === "frame") raw[1].result.frameCompletionIntervalsMs.pop();
        if (scenario === "probe") raw[1].output.ffprobe.result.streams[0].nb_read_frames = "1";
      });
    }
    await assert.rejects(validateCommittedBaseline(root));
  }
});

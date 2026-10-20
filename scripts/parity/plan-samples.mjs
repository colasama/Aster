import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bind deterministic subframe probes to the complete case and authored project. */
export function planSampleSchedule(item, composition, projectSha256) {
  assert(/^[a-f0-9]{64}$/.test(projectSha256), "Plan sampling requires a project SHA-256");
  assert.equal(composition.id, item.composition, "Plan sampling composition differs");
  const { numerator, denominator } = composition.frameRate;
  assert([numerator, denominator].every((n) => Number.isSafeInteger(n) && n > 0));
  const duration = composition.duration;
  assert(Number.isFinite(duration) && duration > 0, "Invalid sampling duration");
  assert(Array.isArray(item.frames) && item.frames.length > 0, "Missing declared frames");
  assert.equal(new Set(item.frames).size, item.frames.length, "Duplicate declared frames");
  const rate = numerator / denominator;
  const count = Math.ceil(duration * rate);
  assert(Number.isSafeInteger(count) && count > 0, "Unbounded sampling frame count");
  const samples = item.frames.map((frame, index) => {
    assert(Number.isSafeInteger(frame) && frame >= 0 && frame < count, "Invalid declared frame");
    return { index, kind: "declared", frame, time: (frame * denominator) / numerator };
  });
  const seed = hash({ version: 1, case: item, project_sha256: projectSha256 });
  const seen = new Set(samples.map((s) => s.time));
  for (let index = 0; index < 64; index++) {
    let time;
    for (let attempt = 0; attempt < 1024; attempt++) {
      const bytes = createHash("sha256").update(JSON.stringify({ seed, index, attempt })).digest();
      const unit = Number(bytes.readBigUInt64BE(0) >> 11n) / 2 ** 53;
      const candidate = unit * duration;
      if (
        candidate > 0 &&
        candidate < duration &&
        !seen.has(candidate) &&
        !Number.isInteger(candidate * rate)
      ) {
        time = candidate;
        break;
      }
    }
    assert(time !== undefined, "Cannot produce a distinct subframe sample");
    seen.add(time);
    samples.push({ index: samples.length, kind: "random", time });
  }
  return {
    schema_version: 1,
    algorithm: "sha256-u53-v1",
    seed,
    composition: composition.id,
    duration,
    frame_rate: { numerator, denominator },
    random_count: 64,
    samples,
  };
}

export function validatePlanSampleSchedule(schedule, item, composition, projectSha256) {
  assert.deepEqual(
    schedule,
    planSampleSchedule(item, composition, projectSha256),
    "Plan sample schedule does not match authenticated inputs",
  );
}

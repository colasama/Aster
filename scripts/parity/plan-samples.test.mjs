import assert from "node:assert/strict";
import test from "node:test";
import { planSampleSchedule, validatePlanSampleSchedule } from "./plan-samples.mjs";

const c = {
  id: "fractional",
  composition: "main",
  frames: [23, 0, 1],
  aa: "off",
  size: { width: 2, height: 2 },
};
const comp = { id: "main", duration: 1.01, frameRate: { numerator: 24000, denominator: 1001 } };
const hash = "a".repeat(64);
test("declared ordering and 64 distinct reproducible subframe times survive JSON", () => {
  const s = planSampleSchedule(c, comp, hash);
  assert.equal(s.samples.length, 67);
  assert.deepEqual(
    s.samples.slice(0, 3).map((v) => v.frame),
    [23, 0, 1],
  );
  assert.equal(s.samples[0].time, (23 * 1001) / 24000);
  const random = s.samples.filter((v) => v.kind === "random");
  assert.equal(random.length, 64);
  assert.equal(new Set(s.samples.map((v) => v.time)).size, 67);
  for (const v of random) {
    assert(v.time > 0 && v.time < comp.duration);
    assert(!Number.isInteger((v.time * 24000) / 1001));
  }
  validatePlanSampleSchedule(JSON.parse(JSON.stringify(s)), c, comp, hash);
  assert.notDeepEqual(planSampleSchedule(c, comp, "b".repeat(64)).samples, s.samples);
  assert.notEqual(planSampleSchedule({ ...c, aa: "fxaa" }, comp, hash).seed, s.seed);
});
test("tampering, missing probes and invalid time domains fail closed", () => {
  const s = planSampleSchedule(c, comp, hash);
  const changed = structuredClone(s);
  changed.samples[4].time += 0.00001;
  assert.throws(() => validatePlanSampleSchedule(changed, c, comp, hash));
  const truncated = structuredClone(s);
  truncated.samples.pop();
  assert.throws(() => validatePlanSampleSchedule(truncated, c, comp, hash));
  for (const duration of [0, -1, NaN, Infinity, Number.MIN_VALUE])
    assert.throws(() => planSampleSchedule(c, { ...comp, duration }, hash));
  assert.throws(() => planSampleSchedule({ ...c, frames: [0, 0] }, comp, hash));
  assert.throws(() => planSampleSchedule({ ...c, frames: [24, 25] }, comp, hash));
});

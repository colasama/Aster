import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { M0Evidence } from "./m0-evidence.mjs";
import { captureSceneOracle } from "./native-scene-oracle.mjs";
import { runStep } from "./process.mjs";
import { writeAtomicJson } from "./report.mjs";

export async function auditNativeScenes(context, projectInputs, execute = runStep) {
  const output = join(context.output, "scene");
  const coverage = await captureSceneOracle(context.root, output, projectInputs);
  const reader = new M0Evidence(context.root);
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const oracle = JSON.parse((await reader.bytes(coverage.output)).bytes);
  for (const input of oracle.cases) {
    const file = await reader.bytes(input.path);
    assert.equal(file.sha256, input.sha256);
    const item = JSON.parse(file.bytes);
    if (item.project.path.startsWith(local(output))) await reader.bytes(item.project.path);
  }
  const steps = [];
  async function check(id, input, accepted) {
    const step = await execute(
      {
        id,
        file: "cargo",
        args: [
          "test",
          "-p",
          "aster-eval",
          "--test",
          "scene_oracle",
          "native_scene_components_match_ts",
          "--",
          "--ignored",
          "--exact",
        ],
      },
      { ...context, env: { ...context.env, ASTER_SCENE_ORACLE: input } },
    );
    steps.push(step);
    assert(!step.error && !step.signal);
    assert.equal(step.status, accepted ? "passed" : "failed");
    assert.equal(step.exit_code, accepted ? 0 : 101);
    const log = (await reader.bytes(step.log)).bytes.toString("utf8");
    assert(
      accepted
        ? /test result: ok\. 1 passed; 0 failed; 0 ignored/.test(log)
        : /test result: FAILED\. 0 passed; 1 failed; 0 ignored/.test(log),
    );
  }
  await check("native-scene-parity", join(context.root, coverage.output), true);
  const invalid = structuredClone(oracle);
  const first = JSON.parse((await reader.bytes(invalid.cases[0].path)).bytes);
  const sample = first.samples.find((sample) => sample.layers?.length);
  assert(sample, "Scene negative control requires a rendered instance");
  sample.layers[0].layerId = "wrong-layer-identity";
  const wrongCase = join(output, "wrong-layer-case.json");
  await writeAtomicJson(wrongCase, first);
  invalid.cases[0] = {
    path: local(wrongCase),
    sha256: (await reader.bytes(local(wrongCase))).sha256,
  };
  const wrongPath = join(output, "wrong-layer-oracle.json");
  await writeAtomicJson(wrongPath, invalid);
  await reader.bytes(local(wrongPath));
  await check("native-scene-reject-wrong-layer", wrongPath, false);
  const wrongDraw = structuredClone(oracle);
  const drawCase = JSON.parse((await reader.bytes(wrongDraw.cases[0].path)).bytes);
  const drawSample = drawCase.samples.find((sample) => sample.resources?.geometry.batches.length);
  assert(drawSample, "Scene negative control requires a geometry batch");
  drawSample.resources.geometry.batches[0].firstVertex += 1;
  const drawCasePath = join(output, "wrong-draw-case.json");
  await writeAtomicJson(drawCasePath, drawCase);
  wrongDraw.cases[0] = {
    path: local(drawCasePath),
    sha256: (await reader.bytes(local(drawCasePath))).sha256,
  };
  const drawPath = join(output, "wrong-draw-oracle.json");
  await writeAtomicJson(drawPath, wrongDraw);
  await reader.bytes(local(drawPath));
  await check("native-scene-reject-wrong-draw", drawPath, false);
  const stale = structuredClone(oracle);
  stale.sources[0].sha256 = "0".repeat(64);
  const stalePath = join(output, "stale-source-oracle.json");
  await writeAtomicJson(stalePath, stale);
  await reader.bytes(local(stalePath));
  await check("native-scene-reject-stale-source", stalePath, false);
  return {
    status: "passed",
    scope: "clock-visibility-parenting-precomposition-camera-lighting-geometry-components",
    whole_project_plan_parity: false,
    ...coverage,
    steps,
    checked_files: await reader.stable(),
  };
}

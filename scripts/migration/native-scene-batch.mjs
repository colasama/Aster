import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { validateFrameArtifacts } from "../parity/frame-artifacts.mjs";
import { writeAtomicJson } from "./report.mjs";
import { hashFile } from "./source.mjs";
import { suppliedFrameRecord } from "./supplied-frame-inputs.mjs";

export const nativeSceneCases = [
  "scene-camera-orthographic",
  "scene-camera-perspective",
  "scene-lighting-directional",
  "scene-lighting-point",
  "scene-lighting-spot",
  "scene-particles-billboard",
  "scene-particles-mesh",
  "scene-particles-streak",
  "scene-audio-spectrum-bars",
  "scene-audio-spectrum-ring",
  "scene-audio-spectrum-scope",
  "scene-dof-15",
  "scene-dof-55",
  "scene-dof-95",
];

/** Execute supplied cameras and complete depth passes against independently frozen frames. */
export async function runNativeSceneBatch(context, inputs, execute) {
  const { reader, binary, base, manifest, corpus, compiler, validateReceipt } = inputs;
  const local = (path) => relative(context.root, path).replaceAll("\\", "/");
  const jobs = [],
    frames = [],
    candidate = [];
  for (const id of nativeSceneCases) {
    const item = corpus.cases.find((c) => c.id === id);
    assert(item);
    const source = manifest.cases.find((c) => c.case_id === id);
    assert(source);
    const captured = await reader.json(`${base}/${source.path}`, source.capture_sha256);
    assert.deepEqual(captured.inputs.case, item);
    const cache = new Map();
    for (const frame of item.frames) {
      const selected = await suppliedFrameRecord(reader, item, frame, base, manifest);
      const { meta } = selected;
      await validateFrameArtifacts(
        async (path) => (await reader.bytes(`${selected.base}/${id}/${path}`)).bytes,
        meta,
        item,
        selected.manifest.source,
        cache,
      );
      const path = `${selected.base}/${id}/${frame}/replay.fpln`;
      const plan = await reader.bytes(path);
      jobs.push({
        plan: path,
        resources: `${selected.base}/${id}/frame-resources`,
        out: join(context.output, "native", id, `${frame}.png`),
      });
      frames.push({
        case_id: id,
        frame,
        input: { path, sha256: plan.sha256 },
        expected: { ...item.size, adapter: meta.adapter.gpuMemory.device },
      });
    }
  }
  const depthStart = frames.findIndex((f) => f.case_id.startsWith("scene-dof-"));
  assert(depthStart >= 0);
  for (const [i, index] of [0, depthStart, depthStart].entries())
    jobs.push({ ...jobs[index], out: join(context.output, `depth-lifetime-${i}.png`) });
  const request = join(context.output, "scene-batch.json");
  await writeAtomicJson(request, jobs);
  const step = await execute(
    {
      id: "native-scene-batch",
      file: binary,
      args: ["render-plan", "--batch", request, ...(compiler ? ["--dxcompiler", compiler] : [])],
      timeout_ms: 120000,
    },
    context,
  );
  assert.equal(step.status, "passed", `Native scenes failed: ${step.log}`);
  const receipts = (await readFile(join(context.root, step.log), "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.startsWith('{"schema_version":'))
    .map((line) => JSON.parse(line));
  assert.equal(receipts.length, jobs.length);
  for (const [index, frame] of frames.entries()) {
    const receipt = receipts[index],
      path = local(jobs[index].out);
    const pixels = await reader.image(path);
    validateReceipt(receipt, {
      ...frame.expected,
      plan_sha256: frame.input.sha256,
      rgba_sha256: pixels.rgba_sha256,
    });
    assert.equal(receipt.frame_index, index);
    assert.equal(receipt.renderer_reused, index > 0);
    assert.equal(receipt.native_image_decode, false);
    const depth = frame.case_id.startsWith("scene-dof-");
    assert.equal(receipt.depth_effects.passes, depth ? 5 : 0);
    if (depth) {
      assert(receipt.depth_effects.resident_bytes > 0);
      assert.equal(receipt.depth_effects.allocations, 1);
      assert.equal(receipt.depth_effects.reuses, index - depthStart);
    }

    assert.equal(receipt.output, jobs[index].out);
    delete frame.expected;
    Object.assign(frame, { receipt, step, output: { path, sha256: pixels.png_sha256 } });
    candidate.push({
      case_id: frame.case_id,
      frame: frame.frame,
      path: relative(context.output, jobs[index].out).replaceAll("\\", "/"),
      png_sha256: pixels.png_sha256,
    });
  }
  const controls = [];
  for (const [i, index] of [0, depthStart, depthStart].entries()) {
    const receipt = receipts[frames.length + i];
    const pixels = await reader.image(local(jobs[frames.length + i].out));
    assert.equal(pixels.rgba_sha256, receipts[index].rgba_sha256);
    assert.equal(receipt.rgba_sha256, pixels.rgba_sha256);
    assert.equal(receipt.depth_effects.retirements, 1);
    assert.equal(receipt.depth_effects.allocations, i === 0 ? 1 : 2);
    assert.equal(receipt.depth_effects.passes, i === 0 ? 0 : 5);
    assert.equal(receipt.depth_effects.reuses, i === 2 ? 12 : 11);
    if (i === 0) assert.equal(receipt.depth_effects.resident_bytes, 0);
    controls.push({
      id: ["retire", "recreate", "reuse"][i],
      receipt,
      output: { path: local(jobs[frames.length + i].out), sha256: pixels.png_sha256 },
      exact: true,
    });
  }
  const rejectedOutput = join(context.output, "rejected-depth-budget.png");
  const rejected = await execute(
    {
      id: "native-depth-budget",
      file: binary,
      args: [
        "render-plan",
        "--plan",
        jobs[depthStart].plan,
        "--resources",
        jobs[depthStart].resources,
        "--out",
        rejectedOutput,
        "--gpu-budget-bytes",
        "16",
        ...(compiler ? ["--dxcompiler", compiler] : []),
      ],
    },
    context,
  );
  assert.equal(rejected.exit_code, 2);
  assert.match(await readFile(join(context.root, rejected.log), "utf8"), /GPU allocation budget/);
  await assert.rejects(stat(rejectedOutput), { code: "ENOENT" });
  return {
    cases: nativeSceneCases,
    frames,
    candidate,
    batch: {
      status: "passed",
      step,
      request: { path: local(request), sha256: await hashFile(request) },
      frames: frames.length,
      executions: jobs.length,
      device_reuses: jobs.length - 1,
      depth_effects: receipts.at(-1).depth_effects,
      controls,
      budget_rejection: rejected,
    },
  };
}

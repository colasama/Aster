import assert from "node:assert/strict";
import { posix } from "node:path";
import { sha256 } from "./m0-evidence.mjs";
import { mediaReceipts } from "./m6-media.mjs";
import { auditSceneRejection, sceneLocal } from "./m7-evidence.mjs";
import { generatorAudioFixtures } from "./native-generator-audio-fixtures.mjs";
import { nativeSceneCases } from "./native-scene-batch.mjs";

export async function auditSceneLifetimes(reader, native, report) {
  const batch = native.scene_batch;
  const receipts = await mediaReceipts(reader, batch.step, report);
  const jobs = await reader.json(batch.request.path, batch.request.sha256);
  assert.equal(
    sceneLocal(reader, batch.step.command[batch.step.command.indexOf("--batch") + 1]),
    batch.request.path,
  );
  const frames = native.frames.filter((f) => nativeSceneCases.includes(f.case_id));
  assert.equal(receipts.length, frames.length + 3);
  assert.equal(jobs.length, receipts.length);
  assert.equal(batch.device_reuses, jobs.length - 1);
  const depthStart = frames.findIndex((f) => f.case_id.startsWith("scene-dof-"));
  assert(depthStart >= 0);
  for (const [i, frame] of frames.entries()) {
    assert.deepEqual(frame.receipt, receipts[i]);
    assert.equal(sceneLocal(reader, jobs[i].plan), frame.input.path);
    assert.equal(sceneLocal(reader, jobs[i].out), frame.output.path);
    const depth = frame.case_id.startsWith("scene-dof-");
    assert.equal(receipts[i].depth_effects.passes, depth ? 5 : 0);
    if (depth) {
      assert(receipts[i].depth_effects.resident_bytes > 0);
      assert.equal(receipts[i].depth_effects.allocations, 1);
      assert.equal(receipts[i].depth_effects.reuses, i - depthStart);
    }
  }
  assert.deepEqual(
    batch.controls.map((c) => c.id),
    ["retire", "recreate", "reuse"],
  );
  for (const [i, original] of [0, depthStart, depthStart].entries()) {
    const index = frames.length + i,
      receipt = receipts[index],
      control = batch.controls[i];
    assert.deepEqual(control.receipt, receipt);
    assert.equal(control.exact, true);
    assert.equal(sceneLocal(reader, jobs[index].plan), frames[original].input.path);
    assert.equal(receipt.plan_sha256, frames[original].input.sha256);
    assert.equal(receipt.frame_index, index);
    assert.equal(receipt.renderer_reused, true);
    const image = await reader.image(control.output.path, control.output.sha256);
    assert.equal(sceneLocal(reader, receipt.output), control.output.path);
    assert.equal(receipt.output, jobs[index].out);
    assert.equal(image.rgba_sha256, receipt.rgba_sha256);
    assert.equal(image.rgba_sha256, frames[original].receipt.rgba_sha256);
    assert.equal(receipt.depth_effects.retirements, 1);
    assert.equal(receipt.depth_effects.allocations, i === 0 ? 1 : 2);
    assert.equal(receipt.depth_effects.passes, i === 0 ? 0 : 5);
    assert.equal(receipt.depth_effects.reuses, frames.length - depthStart - 1 + Number(i === 2));
    if (i === 0) assert.equal(receipt.depth_effects.resident_bytes, 0);
  }
  assert.deepEqual(batch.depth_effects, receipts.at(-1).depth_effects);
  assert.equal(
    batch.budget_rejection.command[
      batch.budget_rejection.command.indexOf("--gpu-budget-bytes") + 1
    ],
    "16",
  );
  await auditSceneRejection(
    reader,
    batch.budget_rejection,
    report,
    /GPU allocation budget/,
    frames[depthStart].input.sha256,
  );
  return { frames: frames.length, executions: receipts.length, restored: 3, rejections: 1 };
}

export async function auditGeneratorAudio(reader, native, report, base) {
  const group = native.native_generator_audio;
  assert.deepEqual(
    await reader.json(`${posix.dirname(native.build.log)}/native-generator-audio/report.json`),
    group,
  );
  const fixtures = await generatorAudioFixtures(reader.root, base);
  const accepted = fixtures.filter((f) => f.mode !== "conflict");
  const restored = fixtures.filter((f) => f.mode === "silent");
  const receipts = await mediaReceipts(reader, group.step, report);
  assert.deepEqual(receipts, group.receipts);
  const jobs = await reader.json(group.batch.path, group.batch.sha256);
  assert.equal(
    sceneLocal(reader, group.step.command[group.step.command.indexOf("--batch") + 1]),
    group.batch.path,
  );
  assert.equal(jobs.length, 12);
  assert.equal(receipts.length, jobs.length);
  const images = new Map();
  for (const [i, f] of [...accepted, ...restored].entries()) {
    const replay = i >= accepted.length;
    const original = native.frames.find(
      (frame) => frame.case_id === f.case_id && frame.frame === 6,
    );
    assert(original);
    assert.deepEqual(f.source, original.input);
    const expected = replay ? original.input.sha256 : sha256(f.plan);
    const planPath = sceneLocal(reader, jobs[i].plan);
    await reader.bytes(planPath, expected);
    if (replay) assert.equal(planPath, original.input.path);
    else {
      assert.deepEqual(
        await reader.json(`${posix.dirname(planPath)}/resources.json`),
        f.resources.map((r) => r.message),
      );
      for (const r of f.resources)
        await reader.bytes(
          `${sceneLocal(reader, jobs[i].resources)}/${r.message.hash}.bin`,
          sha256(r.bytes),
        );
    }
    const receipt = receipts[i];
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.native_gpu_execution, true);
    assert.equal(receipt.frame_index, i);
    assert.equal(receipt.renderer_reused, i > 0);
    assert.equal(receipt.plan_sha256, expected);
    assert.equal(receipt.output, jobs[i].out);
    const image = await reader.image(sceneLocal(reader, jobs[i].out));
    assert.equal(image.rgba_sha256, receipt.rgba_sha256);
    if (replay) assert.equal(image.rgba_sha256, original.receipt.rgba_sha256);
    images.set(replay ? `${f.id}-restored` : f.id, image);
  }
  for (const [i, kind] of ["bars", "ring", "scope"].entries()) {
    const f = fixtures.find((f) => f.id === `${kind}-silent`);
    const original = native.frames.find(
      (frame) => frame.case_id === f.case_id && frame.frame === 6,
    );
    const reference = await reader.image(original.output.path, original.output.sha256);
    const silent = images.get(`${kind}-silent`),
      shared = images.get(`${kind}-shared`),
      inherited = images.get(`${kind}-inherited`);
    const changed = (image) =>
      image.pixels.reduce((n, value, index) => n + Number(value !== reference.pixels[index]), 0);
    const control = group.controls[i];
    assert.equal(control.silent_changed_bytes, changed(silent));
    assert.equal(control.sibling_changed_bytes, changed(shared));
    assert(changed(silent) > 16 && changed(shared) > 16);
    assert.equal(shared.rgba_sha256, inherited.rgba_sha256);
    assert.equal(images.get(`${kind}-silent-restored`).rgba_sha256, reference.rgba_sha256);
    for (const field of ["silent_changed", "sibling_visible", "shared_exact", "restored_exact"])
      assert.equal(control[field], true);
    const rejection = group.rejections[i],
      conflict = fixtures.find((f) => f.id === `${kind}-conflict`);
    assert.equal(rejection.kind, kind);
    assert.equal(rejection.output_absent, true);
    await auditSceneRejection(
      reader,
      rejection.step,
      report,
      /generator audio differs within frame/,
      sha256(conflict.plan),
    );
  }
  return { executions: receipts.length, exact_replays: 6, observable_controls: 6, rejections: 3 };
}

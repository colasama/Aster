import assert from "node:assert/strict";
import { posix } from "node:path";
import { sha256 } from "./m0-evidence.mjs";
import { mediaReceipts } from "./m6-media.mjs";
import { auditSceneComparison, auditSceneRejection, sceneLocal } from "./m7-evidence.mjs";
import { sceneSupplementScope } from "./m7-scope.mjs";
import { validateNativeReceipt } from "./native-core-gate.mjs";

async function auditGroup(reader, native, report, ledger, scope) {
  const group = native[scope.name],
    pin = ledger.reference_baseline[scope.name];
  assert.deepEqual(group.reference, pin);
  const frozen = await reader.json(pin.path, pin.sha256);
  assert.equal(frozen.status, "passed");
  assert.deepEqual(
    frozen.frames.map((f) => f.id),
    scope.ids,
  );
  assert.deepEqual(group.controls, frozen.controls);
  const gpu = frozen.gpu_info.gpuDevice.find((g) => g.active);
  assert(gpu);
  const adapter = { name: gpu.deviceString, vendorId: gpu.vendorId, deviceId: gpu.deviceId };
  const recursive = scope.name === "native_generator_surfaces";
  const restored = recursive
    ? ["bars", "ring", "scope"].map((kind) =>
        frozen.frames.find((f) => f.id === `${kind}-off-child`),
      )
    : [];
  const executionFrames = [...frozen.frames, ...restored];
  for (const frame of frozen.frames) {
    assert.equal(frame.repeated_exact, true);
    for (const evidence of [
      frame.plan,
      frame.reference,
      frame.source,
      frame.generator_source,
    ].filter((p) => p && typeof p === "object"))
      await reader.bytes(evidence.path, evidence.sha256);
    for (const resource of frame.resources) await reader.bytes(resource.path, resource.sha256);
    assert.deepEqual(
      await reader.json(`${posix.dirname(frame.plan.path)}/resources.json`),
      frame.resources.map((r) => r.message),
    );
  }
  const runs = [];
  for (const [batchIndex, batch] of group.batches.entries()) {
    const step = batch.step ?? batch;
    const receipts = await mediaReceipts(reader, step, report);
    const requestPath = sceneLocal(reader, step.command[step.command.indexOf("--batch") + 1]);
    if (batch.request) assert.equal(batch.request.path, requestPath);
    const jobs = await reader.json(requestPath, batch.request?.sha256);
    assert.equal(jobs.length, executionFrames.length);
    assert.equal(receipts.length, jobs.length);
    assert.equal(
      step.command[step.command.indexOf("--layer-cache-bytes") + 1],
      batchIndex ? "67108864" : "0",
    );
    const images = [];
    for (const [i, f] of executionFrames.entries()) {
      const receipt = receipts[i],
        job = jobs[i];
      assert.equal(sceneLocal(reader, job.plan), f.plan.path);
      assert.equal(sceneLocal(reader, job.resources), posix.dirname(f.resources[0].path));
      assert.equal(receipt.output, job.out);
      const pixels = await reader.image(sceneLocal(reader, job.out));
      validateNativeReceipt(receipt, {
        width: f.width,
        height: f.height,
        adapter,
        plan_sha256: f.plan.sha256,
        rgba_sha256: pixels.rgba_sha256,
      });
      assert.equal(receipt.frame_index, i);
      assert.equal(receipt.renderer_reused, i > 0);
      if (i < frozen.frames.length) assert.deepEqual(group.frames[i].receipts[batchIndex], receipt);
      if (batchIndex) assert.equal(pixels.rgba_sha256, runs[0].images[i].rgba_sha256);
      if (i >= frozen.frames.length)
        assert.equal(
          pixels.rgba_sha256,
          images[frozen.frames.findIndex((v) => v.id === f.id)].rgba_sha256,
        );
      if (scope.name === "native_generator_output" || scope.name === "native_scene_output") {
        assert.equal(receipt.motion_reconstruction.passes, f.motion ? 3 : 0);
        if (!f.motion) assert.equal(receipt.motion_reconstruction.resident_bytes, 0);
        const depth = f.mode.startsWith("depth");
        assert.equal(
          receipt.depth_effects.passes,
          depth
            ? scope.name === "native_generator_output"
              ? 5
              : [1, 3, 4][f.tier] + Number(f.ready)
            : 0,
        );
        if (!depth) assert.equal(receipt.depth_effects.resident_bytes, 0);
      }
      if (f.normal) {
        assert.equal(receipt.native_textures.length, 1);
        const texture = receipt.native_textures[0];
        assert.equal(texture.encoded, f.normal);
        assert.equal(texture.encoding, f.encoding);
        const catalog = await reader.json(
          `tests/parity/assets/${scope.name === "native_animated_normal" ? "animated-" : ""}normal-textures.json`,
        );
        const expected = catalog.fixtures.find((v) => v.message.hash === f.normal);
        assert(expected);
        for (const field of ["width", "height", "rgba_sha256"])
          assert.equal(texture[field], expected[field]);
      }
      images.push(pixels);
    }
    if (recursive)
      for (const [i, f] of frozen.frames.entries()) {
        if (f.mode === "shared")
          assert.equal(
            images[i].rgba_sha256,
            images[frozen.frames.findIndex((v) => v.id === f.id.replace(/shared$/, "inherited"))]
              .rgba_sha256,
          );
      }
    if (scope.name === "native_generator_output")
      for (const kind of ["bars", "ring", "scope"])
        for (const aa of ["off", "fxaa", "ssaa2x", "ssaa4x"]) {
          const find = (mode) =>
            images[frozen.frames.findIndex((f) => f.id === `${kind}-${aa}-${mode}`)].rgba_sha256;
          assert.equal(find("normal"), find("empty"));
        }
    runs.push({ images, jobs });
  }
  const references = new Map();
  for (const [i, frame] of group.frames.entries()) {
    const pair = await auditSceneComparison(
      reader,
      frame,
      frozen.frames[i],
      runs[0].jobs[i].out,
      report,
      ledger,
    );
    references.set(frozen.frames[i].id, pair.reference);
  }
  for (const control of frozen.controls) {
    const left = references.get(control.left ?? `depthOfField-${control.aa}-${control.a}`)?.pixels;
    const right = references.get(
      control.right ?? `depthOfField-${control.aa}-${control.b}`,
    )?.pixels;
    assert(left && right);
    const changed = left.reduce((n, v, i) => n + Number(v !== right[i]), 0);
    assert(changed > 16);
    assert.equal(changed, control.changed_bytes);
  }
  if (recursive) {
    const negatives = await reader.json(pin.negative_inputs.path, pin.negative_inputs.sha256);
    assert.deepEqual(
      negatives.map((f) => f.id),
      ["bars", "ring", "scope"].flatMap((kind) =>
        ["off", "fxaa", "ssaa2x", "ssaa4x"].map((aa) => `${kind}-${aa}-conflict`),
      ),
    );
    for (const [i, f] of negatives.entries()) {
      const step = group.rejections[i];
      assert.equal(step.id, `reject-${f.id}`);
      await auditSceneRejection(
        reader,
        step,
        report,
        /generator audio differs within root frame/,
        sha256(Buffer.from(f.plan)),
      );
      const resources = sceneLocal(reader, step.command[step.command.indexOf("--resources") + 1]);
      assert.deepEqual(
        await reader.json(`${posix.dirname(resources)}/resources.json`),
        f.resources.map((r) => r.message),
      );
      for (const r of f.resources)
        await reader.bytes(`${resources}/${r.message.hash}.bin`, sha256(Buffer.from(r.bytes)));
    }
  } else if (scope.name !== "native_generator_output") {
    const step = group.budget_rejection;
    assert.equal(step.command[step.command.indexOf("--gpu-budget-bytes") + 1], "16");
    const planPath = sceneLocal(reader, step.command[step.command.indexOf("--plan") + 1]);
    const frame = frozen.frames.find((f) => f.plan.path === planPath);
    assert(frame);
    await auditSceneRejection(reader, step, report, /GPU allocation budget/, frame.plan.sha256);
  }
  return {
    frames: frozen.frames.length,
    executions: executionFrames.length * 2,
    cache_exact: executionFrames.length,
    controls: frozen.controls.length,
    rejections: recursive ? 12 : scope.name === "native_generator_output" ? 0 : 1,
  };
}

export async function auditM7Supplements(reader, native, report, ledger) {
  const result = {};
  const output = posix.dirname(native.build.log);
  for (const scope of sceneSupplementScope()) {
    assert.deepEqual(
      await reader.json(`${output}/${scope.name.replaceAll("_", "-")}/report.json`),
      native[scope.name],
    );
    result[scope.name] = await auditGroup(reader, native, report, ledger, scope);
  }
  return result;
}

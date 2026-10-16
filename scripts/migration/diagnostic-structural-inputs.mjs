import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Reconstruct diagnostic inputs from the production capture, never from replay raster plans. */
export async function diagnosticStructuralInputs(reader, diagnostic, mode) {
  assert(["root", "recursive"].includes(mode));
  const capture = await reader.json(diagnostic.input.path, diagnostic.input.sha256);
  assert.equal(capture.status, "passed");
  assert.equal(capture.source.execution_sha256, diagnostic.source.execution_sha256);
  const frames = capture.frames.filter((f) => f.mode === mode);
  assert.equal(frames.length, 3);
  const devices = capture.gpu_info.gpuDevice.filter((d) => d.active);
  assert.equal(devices.length, 1);
  const gpu = devices[0];
  const adapter = { name: gpu.deviceString, vendorId: gpu.vendorId, deviceId: gpu.deviceId };
  const inputs = [];
  for (const [index, frame] of frames.entries()) {
    assert.equal(frame.id, `${mode}-${index}`);
    assert.deepEqual(frame.job, frames[0].job);
    const plan = (await reader.bytes(frame.plan.path, frame.plan.sha256)).bytes;
    const metadata = JSON.parse(plan.subarray(32, 32 + plan.readUInt32LE(8)));
    const manifest = `${dirname(frame.plan.path).replaceAll("\\", "/")}/resources.json`;
    const messages = await reader.json(manifest);
    for (const hash of metadata.resources) {
      const resource = frame.resources.find((r) => r.message.hash === hash);
      assert(resource, "Production plan resource missing from capture");
      assert.deepEqual(
        messages.find((m) => m.hash === hash),
        resource.message,
      );
      await reader.bytes(
        `${dirname(diagnostic.input.path)}/resources/${hash}.bin`,
        resource.sha256,
      );
    }
    await reader.image(frame.reference.path, frame.reference.sha256);
    inputs.push({
      frame: index,
      plan: frame.plan,
      resources: `${dirname(diagnostic.input.path).replaceAll("\\", "/")}/resources`,
      adapter,
    });
  }
  return {
    frames,
    assignment: {
      case: {
        id: `native-encoded-${mode}`,
        size: { width: frames[0].width, height: frames[0].height },
        frames: [0, 1, 2],
      },
      capture: diagnostic.input,
      inputs,
    },
  };
}

/** Reuse main-process authorization semantics; callers persist bytes before disposing the lease. */
export async function diagnosticMediaGrants(root, manifest) {
  const { NativeMediaGrants } = await import(
    pathToFileURL(join(root, "dist-electron/electron/native-media-grants.js"))
  );
  const lease = await NativeMediaGrants.create(
    join(tmpdir(), "aster-diagnostic-witness"),
    manifest,
    [],
  );
  try {
    return { lease, grants: JSON.parse(await readFile(lease.path, "utf8")) };
  } catch (error) {
    await lease.dispose();
    throw error;
  }
}

export async function auditDiagnosticGrants(reader, pin, manifest) {
  const actual = await reader.json(pin.path, pin.sha256);
  const { lease, grants } = await diagnosticMediaGrants(reader.root, manifest);
  try {
    assert.deepEqual(
      actual.map(({ path: _path, ...identity }) => identity),
      grants.map(({ path: _path, ...identity }) => identity),
    );
    for (const grant of actual)
      await reader.bytes(
        relative(reader.root, resolve(grant.path)).replaceAll("\\", "/"),
        grant.sha256,
      );
  } finally {
    await lease.dispose();
  }
}

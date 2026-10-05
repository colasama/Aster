import assert from "node:assert/strict";

export function motionNegativeFixtures(runtime) {
  const source = runtime.motionReconstructionFixtures()[0].bytes;
  return [
    ["extent", 0, 0],
    ["samples", 8, 0],
    ["nonfinite", 16, 0x7fc00000],
    ["padding", 24, 1],
  ].map(([id, offset, word]) => {
    const bytes = new Uint8Array(source);
    const view = new DataView(bytes.buffer);
    view.setUint32(view.getUint32(16, true) + offset, word, true);
    return { id: `motion-${id}`, bytes, code: "invalid_header" };
  });
}

export function auditMotionReconstruction(runtime, fixture, plan) {
  const expected = fixture.motion;
  const decoded = runtime.readMotionReconstructionPlan(plan);
  assert.equal(decoded.slice.status, expected.status);
  assert.equal(runtime.frameTimeToNumber(decoded.slice.shutter_open), expected.open);
  assert.equal(runtime.frameTimeToNumber(decoded.slice.shutter_duration), expected.duration);
  const uniforms = new DataView(new ArrayBuffer(32));
  for (const [offset, value] of [
    [0, 64],
    [4, 48],
    [16, expected.radius],
    [20, expected.position],
  ])
    uniforms.setFloat32(offset, value, true);
  uniforms.setUint32(8, expected.samples, true);
  uniforms.setUint32(12, expected.adaptive, true);
  assert.deepEqual(decoded.uniforms, new Uint8Array(uniforms.buffer));
  const saved = [globalThis.GPUBufferUsage, globalThis.GPUTextureUsage];
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 };
  try {
    const writes = [],
      passes = [];
    const texture = () => ({ createView: () => ({}), destroy() {} });
    const device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createBuffer: () => ({ destroy() {} }),
      createTexture: texture,
      createBindGroup: () => ({}),
      queue: { writeBuffer: (_buffer, _offset, bytes) => writes.push(new Uint8Array(bytes)) },
    };
    const encoder = {
      beginRenderPass: (descriptor) => {
        passes.push(descriptor.label);
        return { setPipeline() {}, setBindGroup() {}, draw: (n) => assert.equal(n, 3), end() {} };
      },
    };
    const renderer = new runtime.MotionBlurRenderer(device);
    const execute = () => renderer.encodePlan(encoder, plan);
    if (expected.status === "ready") assert.throws(execute, { code: "missing_resource" });
    else assert.equal(execute(), false);
    assert.equal(passes.length, 0);
    renderer.setSources(65, 48, texture(), texture(), texture());
    if (expected.status === "ready")
      assert.throws(execute, { code: "resource_generation_mismatch" });
    else assert.equal(execute(), false);
    assert.equal(writes.length, 0);
    assert.equal(passes.length, 0);
    renderer.setSources(64, 48, texture(), texture(), texture());
    assert.equal(execute(), expected.status === "ready");
    assert.deepEqual(
      passes,
      expected.status === "ready"
        ? [
            "Motion blur tile-max",
            "Motion blur neighbor-max",
            "Motion blur ID-aware linear HDR reconstruction",
          ]
        : [],
    );
    assert.deepEqual(writes, expected.status === "ready" ? [new Uint8Array(uniforms.buffer)] : []);
    decoded.uniforms.fill(255);
    assert.deepEqual(
      runtime.readMotionReconstructionPlan(plan).uniforms,
      new Uint8Array(uniforms.buffer),
    );
    renderer.destroy();
    return {
      id: fixture.id,
      exact_uniforms: true,
      exact_shutter: true,
      supplied_execution: true,
      status: expected.status,
      invalid_attachments_rejected: expected.status === "ready",
    };
  } finally {
    for (const [i, key] of ["GPUBufferUsage", "GPUTextureUsage"].entries()) {
      if (saved[i] === undefined) delete globalThis[key];
      else globalThis[key] = saved[i];
    }
  }
}

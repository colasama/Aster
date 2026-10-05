import assert from "node:assert/strict";

export function auditPostEffect(runtime, fixture, plan) {
  const expected = fixture.postEffect;
  const decoded = runtime.readPostEffectPlan(plan);
  assert.deepEqual(decoded.slice.effect, expected.effect);
  assert.deepEqual(decoded.uniforms, expected.uniforms);
  const saved = globalThis.GPUBufferUsage;
  globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2 };
  try {
    const writes = [],
      bindings = [],
      draws = [];
    const device = {
      createShaderModule: () => ({}),
      createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createBuffer: () => ({ destroy() {} }),
      createBindGroup: (descriptor) => {
        bindings.push(descriptor);
        return descriptor;
      },
      queue: { writeBuffer: (_buffer, _offset, data) => writes.push(new Uint8Array(data)) },
    };
    const depth = expected.effect.kind === "depth";
    const renderer = depth
      ? new runtime.DepthEffectsRenderer(device, "rgba8unorm")
      : new runtime.SurfacePostEffectsRenderer(device, "rgba8unorm");
    const texture = (role) => ({ createView: () => role });
    const setSources = (width, healthy, all = false) => {
      if (depth) {
        const roles = expected.effect.inputs,
          source = roles[0];
        renderer.setSources(
          width,
          48,
          healthy ? texture(source) : undefined,
          healthy ? texture("worldPosition") : undefined,
          healthy && (all || roles[2] === "transparentWorldPosition")
            ? texture("transparentWorldPosition")
            : undefined,
          healthy && (all || roles[3] === "peeledWorldPosition")
            ? texture("peeledWorldPosition")
            : undefined,
          healthy && (all || roles[4] === "frontLayerColor")
            ? texture("frontLayerColor")
            : undefined,
          healthy && (all || roles[5] === "peeledLayerColor")
            ? texture("peeledLayerColor")
            : undefined,
          source,
        );
      } else
        renderer.setSources(
          width,
          48,
          ...["scene", "objectId", "motionVector"].map((role) =>
            healthy ? texture(role) : undefined,
          ),
        );
    };
    setSources(64, expected.ready);
    if (depth) renderer.setSettings(expected.settings);
    else {
      renderer.setSelection(0xfeed1234);
      renderer.setMotionShutterScale(1.5);
    }
    const produced = renderer.buildPlan(plan.metadata.header, expected.effect.mode);
    assert.deepEqual(produced.metadata, plan.metadata);
    assert.deepEqual(
      produced.blobs.map((b) => new Uint8Array(b)),
      plan.blobs.map((b) => new Uint8Array(b)),
    );
    if (depth) renderer.setSettings({ focusDistance: 999, irisRotation: 0 });
    else {
      renderer.setSelection(1);
      renderer.setMotionShutterScale(0);
    }
    const pass = {
      setPipeline() {},
      setBindGroup(_slot, group) {
        draws.push(group);
      },
      draw: (n) => assert.equal(n, 3),
    };
    setSources(64, false);
    if (expected.ready)
      assert.throws(() => renderer.preparePlan(plan), { code: "missing_resource" });
    else assert.equal(renderer.preparePlan(plan)(pass), false);
    assert.equal(writes.length, 0);
    setSources(65, true);
    if (expected.ready)
      assert.throws(() => renderer.preparePlan(plan), { code: "resource_generation_mismatch" });
    assert.equal(writes.length, 0);
    // Replay has every optional attachment; the supplied route must retain captured fallbacks.
    setSources(64, true, true);
    const encode = renderer.preparePlan(plan);
    assert.equal(encode(pass), expected.ready);
    assert.deepEqual(writes, expected.ready ? [expected.uniforms] : []);
    assert.equal(draws.length, expected.ready ? 1 : 0);
    if (expected.ready) {
      const slots = depth ? [0, 1, 4, 5, 6, 7] : [0, 2, 3];
      assert.deepEqual(
        slots.map((slot) => draws[0].entries.find((e) => e.binding === slot).resource),
        expected.effect.inputs,
      );
    }
    renderer.destroy();
    return {
      id: fixture.id,
      exact_uniforms: true,
      exact_routes: true,
      supplied_execution: true,
      settings_independent: true,
      availability_preserved: true,
      ready: expected.ready,
    };
  } finally {
    if (saved === undefined) delete globalThis.GPUBufferUsage;
    else globalThis.GPUBufferUsage = saved;
  }
}

export function postEffectNegativeFixtures(runtime) {
  const fixtures = runtime.postEffectFixtures();
  return [
    ["depth-mode", 0, 8, 0],
    ["depth-nonfinite", 0, 32, 0x7fc00000],
    ["depth-range", 0, 92, 0x43a00000],
    ["surface-mode", 5, 8, 2],
    ["surface-padding", 5, 20, 1],
  ].map(([id, index, offset, word]) => {
    const bytes = new Uint8Array(fixtures[index].bytes),
      view = new DataView(bytes.buffer);
    view.setUint32(view.getUint32(16, true) + offset, word, true);
    return { id: `post-${id}`, bytes, code: "invalid_header" };
  });
}

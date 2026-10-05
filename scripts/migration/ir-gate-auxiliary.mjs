import assert from "node:assert/strict";

export function auditAuxiliary(runtime, fixture, plan) {
  const expected = fixture.auxiliary,
    decoded = runtime.readAuxiliaryPlan(plan);
  assert.deepEqual(decoded.ids, expected.ids);
  assert.deepEqual(decoded.motion, expected.motion);
  const names = ["GPUTextureUsage", "GPUBufferUsage", "GPUShaderStage", "window"],
    saved = names.map((n) => globalThis[n]);
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 };
  globalThis.GPUBufferUsage = { VERTEX: 1, COPY_DST: 2 };
  globalThis.GPUShaderStage = { FRAGMENT: 1 };
  globalThis.window ??= { asterDesktop: { log() {} } };
  try {
    const writes = [],
      passes = [],
      clears = [];
    const device = {
      limits: { maxColorAttachments: 8, maxColorAttachmentBytesPerSample: 64 },
      createShaderModule: () => ({}),
      createPipelineLayout: () => ({}),
      createBindGroupLayout: () => ({}),
      createRenderPipeline: (d) => ({ label: d.label }),
      createBindGroup: (d) => d,
      createTexture: (d) => ({ ...d, createView: () => d.label, destroy() {} }),
      createBuffer: (d) => ({ ...d, destroy() {} }),
      queue: {
        writeBuffer: (buffer, _offset, data) =>
          writes.push({
            label: buffer.label,
            bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(),
          }),
      },
    };
    const encoder = {
      clearBuffer: (b) => clears.push(b),
      beginRenderPass: (d) => {
        const recorded = { descriptor: d, draws: [], bindings: [], vertices: [] };
        passes.push(recorded);
        return {
          setPipeline: (p) => {
            recorded.pipeline = p;
          },
          setVertexBuffer: (i, b) => recorded.vertices.push([i, b]),
          setBindGroup: (i, b) => recorded.bindings.push([i, b]),
          draw: (...args) => recorded.draws.push(args),
          drawIndirect: (b, o) => recorded.draws.push([b, o]),
          end() {},
        };
      },
    };
    const renderer = new runtime.AuxiliaryBufferRenderer(device, {});
    const base = 64 * 48 * 32; // Five MRT attachments (28 bytes) and depth (4 bytes).
    const extra = expected.tier >= 2 ? 36 : expected.tier >= 1 ? 16 : 0;
    const budget = base + 64 * 48 * extra + 1024;
    if (expected.status !== "unavailable")
      assert(renderer.enable(64, 48, budget, expected.tier >= 0));
    const groups = expected.textures.map((_, i) => ({ id: `binding-${i}` }));
    const generatorEntries = decoded.slice.generators.map((id) => ({
      instanceId: runtime.compositionIdentityToString(id),
      draw: { pipeline: {}, bindGroup: {}, indirectBuffer: { id } },
    }));
    let resolutions = 0;
    const produced = renderer.buildPlan({
      header: plan.metadata.header,
      vertexCount: expected.status === "cleared" ? 1000000 : decoded.slice.vertex_count,
      batches: expected.batches,
      motionVectors: expected.motion,
      mediaBinding: (batch) => {
        resolutions++;
        const i = expected.batches.indexOf(batch);
        return i === 0 ? undefined : { texture: expected.textures[i], binding: groups[i] };
      },
      generators: generatorEntries,
    });
    assert.deepEqual(produced.plan.metadata, plan.metadata);
    assert.deepEqual(
      produced.plan.blobs.map((b) => new Uint8Array(b)),
      plan.blobs.map((b) => new Uint8Array(b)),
    );
    assert.equal(resolutions, expected.status === "drawn" ? expected.batches.length : 0);
    assert.equal(writes.length, 0);
    assert.equal(passes.length, 0);
    // A healthier replay device must retain captured unavailability, clear, and tier choices.
    assert(renderer.enable(64, 48, 8 * 1024 * 1024, true));
    const vertices = { size: Math.max(1, decoded.slice.vertex_count) * 160 };
    const run = (candidate = plan, bindings = produced.bindings) =>
      renderer.encodePlan(encoder, candidate, vertices, bindings);
    if (expected.status === "drawn" && !expected.empty) {
      assert.throws(() => run(plan, { ...produced.bindings, media: new Map() }), {
        code: "missing_resource",
      });
      assert.throws(() => run(plan, { ...produced.bindings, generators: new Map() }), {
        code: "missing_resource",
      });
      assert.throws(() => renderer.encodePlan(encoder, plan, { size: 0 }, produced.bindings), {
        code: "invalid_header",
      });
      const stale = structuredClone(plan);
      stale.metadata.header.render_target.width++;
      assert.throws(() => run(stale), { code: "resource_generation_mismatch" });
      assert.equal(writes.length, 0);
      assert.equal(passes.length, 0);
      assert.equal(clears.length, 0);
    }
    assert.equal(run(), expected.status === "drawn");
    assert.equal(renderer.motionShutterScale, expected.motion ? 1 : 0);
    const count =
      expected.status === "unavailable" ? 0 : expected.tier >= 2 ? 4 : expected.tier >= 1 ? 3 : 1;
    assert.equal(passes.length, count);
    if (expected.status !== "drawn") {
      assert.equal(writes.length, 0);
      assert.equal(clears.length, 0);
      assert(passes.every((p) => p.draws.length === 0 && p.vertices.length === 0));
    } else {
      const idWrite = writes.find((w) => w.label === "Auxiliary object/material ID instances");
      if (expected.ids.length) assert.deepEqual(idWrite.bytes, new Uint8Array(expected.ids.buffer));
      if (expected.motion)
        assert(
          writes.some((w) => Buffer.from(w.bytes).equals(Buffer.from(expected.motion.buffer))),
        );
      else assert.equal(clears.length, 1);
      for (const [index, p] of passes.entries()) {
        assert.deepEqual(
          p.draws.slice(0, decoded.slice.draws.length),
          decoded.slice.draws.map((d, i) => [d.vertex_count, 1, d.first_vertex, i]),
        );
        assert.equal(
          p.draws.length,
          decoded.slice.draws.length + (index === 0 ? generatorEntries.length : 0),
        );
        assert.deepEqual(
          p.bindings
            .filter(([slot]) => slot === 0)
            .slice(0, Math.max(0, expected.batches.length - 1))
            .map(([, b]) => b),
          groups.slice(1, expected.batches.length),
        );
      }
      assert.deepEqual(
        passes[0].draws.slice(decoded.slice.draws.length),
        generatorEntries.map((g) => [g.draw.indirectBuffer, 0]),
      );
    }
    renderer.destroy();
    return {
      id: fixture.id,
      exact_payloads: true,
      exact_draws: true,
      supplied_execution: true,
      availability_preserved: true,
      preflight_rejection: true,
    };
  } finally {
    names.forEach((n, i) => {
      if (saved[i] === undefined) delete globalThis[n];
      else globalThis[n] = saved[i];
    });
  }
}

export function auxiliaryNegativeFixtures(runtime) {
  return [
    ["nonfinite", 0, 32, 0x7fc00000],
    ["range", 0, 32, 0x41100000],
    ["padding", 9, 0, 1],
  ].map(([id, index, offset, word]) => {
    const bytes = new Uint8Array(runtime.auxiliaryFixtures()[index].bytes),
      view = new DataView(bytes.buffer);
    view.setUint32(view.getUint32(16, true) + offset, word, true);
    return { id: `auxiliary-${id}`, bytes, code: "invalid_header" };
  });
}

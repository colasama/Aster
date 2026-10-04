import assert from "node:assert/strict";

/** Exercise production upload and draw-resolution consumers with Rust-decoded transport only. */
export async function auditRasterScene(runtime, decoded, fixture, messages, pixelBytes) {
  const raster = fixture.raster;
  const source = messages.find((message) => message.hash === raster.source.hash);
  const frame = messages.find((message) => message.hash === raster.frame.hash);
  const pixels = messages.find((message) => message.hash === raster.message.hash);
  assert(source && frame && pixels, "Rust transcript lacks raster dependencies");
  assert(fixture.expandedTextBounds, "Text fixture did not use supplied ink bounds");
  const registry = new runtime.FrameResourceRegistry({ budget_bytes: 100000, max_resources: 3 });
  for (const message of [source, frame, pixels])
    await registry.apply(message, message.kind === "raster_pixels" ? pixelBytes : undefined);
  const scope = source.descriptor.authorization_scope;
  assert.deepEqual(runtime.decodeRasterPixels(registry, pixels.hash, scope).bounds, fixture.bounds);
  const previousUsage = globalThis.GPUTextureUsage;
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, COPY_SRC: 4 };
  const textures = [];
  const gpu = new runtime.MediaGpuRegistry();
  let installed;
  let lease;
  try {
    installed = runtime.uploadRasterResource(registry, pixels.hash, scope, {
      device: {
        createTexture: () => ({ destroy() {} }),
        queue: { writeTexture: (_target, bytes) => textures.push(Buffer.from(bytes)) },
      },
      maximumDimension: 16384,
      maximumBytes: 100000,
      label: "Decoded raster scene",
      createBindGroup: () => ({ frame: frame.hash }),
    });
    assert.equal(textures.length, 1);
    assert.deepEqual(textures[0], pixelBytes);
    assert.equal(installed.frameHash, frame.hash);
    gpu.apply(installed.messages[0]);
    gpu.apply(installed.messages[1], installed.resource, installed.resource.bindGroup);
    lease = gpu.pin(decoded.metadata.resources);
    for (const plan of [decoded, structuredClone(decoded)]) {
      const prepared = runtime.prepareSceneBuffers(plan);
      const media = runtime.resolveSceneMediaPlan(plan, lease);
      assert.equal(prepared.draws.length, 1);
      assert.equal(prepared.draws[0].firstVertex, 0);
      assert.equal(prepared.draws[0].vertexCount, 6);
      assert.equal(media.length, 1);
      assert.equal(media[0].drawIndex, 0);
      assert.equal(media[0].hash, frame.hash);
      assert.equal(media[0].binding, installed.resource.bindGroup);
      const writes = [];
      runtime.uploadSceneBuffers(prepared, {
        queue: {
          writeBuffer: (_target, _offset, bytes, offset, length) =>
            writes.push(Buffer.from(new Uint8Array(bytes, offset, length))),
        },
        shapeBuffer: {},
        lightingBuffer: {},
        ensureShapeBuffer() {},
      });
      assert.equal(writes.length, 2);
      assert.deepEqual(writes[1], Buffer.from(fixture.expectedVertices));
    }
    // The pin protects this decoded binding; after release eviction must prevent replay.
    assert.throws(() => gpu.apply({ type: "evict_resource", hash: frame.hash }), {
      code: "resource_in_use",
    });
    lease.release();
    lease = undefined;
    gpu.apply({ type: "evict_resource", hash: frame.hash });
    assert.throws(() => gpu.pin(decoded.metadata.resources), { code: "missing_resource" });
    return {
      id: fixture.id,
      origin: frame.descriptor.sample.origin,
      decoded_geometry_exact: true,
      decoded_pixels_exact: true,
      decoded_bounds_exact: true,
      resource_hash_exact: true,
      clone_replay: true,
      missing_rejected: true,
    };
  } finally {
    lease?.release();
    gpu.destroy();
    if (installed) runtime.destroyMediaResource(installed.resource);
    if (previousUsage === undefined) delete globalThis.GPUTextureUsage;
    else globalThis.GPUTextureUsage = previousUsage;
  }
}

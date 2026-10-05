import assert from "node:assert/strict";
import { createServer } from "vite";

export async function loadIrRuntime(root) {
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, hmr: false, ws: false },
    appType: "custom",
  });
  try {
    const modules = [];
    for (const name of [
      "codec",
      "final-output-plan",
      "final-output-fixture",
      "fixture",
      "resources",
      "media-resource-fixture",
      "raster-sample",
      "raster-pixel-fixture",
      "texture-pixel-fixture",
      "raster-scene-fixture",
      "raster-resource",
      "types",
      "time",
      "composition-identity",
      "root-post-upload",
      "scene-buffer-fixture",
      "scene-buffer-upload",
      "scene-media-fixture",
      "scene-media-plan",
      "camera-fixture",
      "camera-plan",
      "temporal-text-fixture",
      "temporal-text-plan",
      "temporal-text-frame",
      "temporal-pass-fixture",
      "temporal-pass-plan",
      "material-binding-fixture",
      "material-binding-plan",
      "layer-effect-fixture",
      "layer-effect-plan",
      "effect-execution-plan",
      "effect-execution-fixture",
      "root-scene-plan",
      "root-scene-fixture",
      "generator-plan",
      "generator-fixture",
      "precomposition-graph-plan",
      "precomposition-graph-fixture",
      "precomposition-bundle-fixture",
      "precomposition-bundle-read",
      "precomposition-bundle-layout",
    ])
      modules.push(await server.ssrLoadModule(`/src/renderer/frame-plan/${name}.ts`));
    for (const name of [
      "raster-resource-upload",
      "media-gpu-registry",
      "media-resource",
      "texture-pixel-upload",
      "material-texture-plan",
      "material-texture-registry",
    ])
      modules.push(await server.ssrLoadModule(`/src/renderer/media/${name}.ts`));
    modules.push(await server.ssrLoadModule("/src/renderer/text/text-motion-blur-pass-plan.ts"));
    modules.push(await server.ssrLoadModule("/src/renderer/compositing/execute-final-output.ts"));
    return Object.assign({ close: () => server.close() }, ...modules);
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** Independently exercise the public TS resource boundary in the actual gate process. */
export async function auditIrResources(runtime) {
  const descriptor = { element_type: "u8", element_count: 4, byte_length: 4 };
  // Buffer subclasses Uint8Array but Buffer.slice aliases memory: the registry must really copy.
  const bytes = Buffer.from([1, 2, 3, 4]);
  const hash = await runtime.resourceHash(descriptor, bytes);
  const message = { type: "put_resource", kind: "buffer", hash, descriptor };
  const registry = new runtime.FrameResourceRegistry({ budget_bytes: 4, max_resources: 2 });
  await assert.rejects(registry.apply({ ...message, hash: "0".repeat(64) }, bytes), {
    code: "hash_mismatch",
  });
  assert.equal(registry.size, 0);
  const pending = registry.apply(message, bytes);
  bytes.fill(9);
  await pending;
  await registry.apply(message, new Uint8Array([1, 2, 3, 4]));
  assert.equal(registry.usedBytes, 4);
  assert.equal(registry.size, 1);
  const extra = new Uint8Array([7]);
  const extraDescriptor = { element_type: "u8", element_count: 1, byte_length: 1 };
  const extraHash = await runtime.resourceHash(extraDescriptor, extra);
  await assert.rejects(
    registry.apply({ ...message, hash: extraHash, descriptor: extraDescriptor }, extra),
    { code: "resource_budget_exceeded" },
  );
  assert.equal(registry.usedBytes, 4);
  assert.throws(() => registry.pin([hash, extraHash]), { code: "missing_resource" });
  const lease = registry.pin([hash]);
  await assert.rejects(registry.apply({ type: "evict_resource", hash }), {
    code: "resource_in_use",
  });
  lease.release();
  lease.release();
  await registry.apply({ type: "evict_resource", hash });
  assert.equal(registry.usedBytes, 0);
  assert.throws(() => registry.pin([hash]), { code: "missing_resource" });
  return {
    status: "passed",
    resource_hash: hash,
    checks: [
      "descriptor_content_hash",
      "wrong_hash",
      "input_ownership",
      "idempotent_put",
      "budget_atomicity",
      "atomic_pin",
      "pinned_eviction",
      "missing_resource",
    ],
  };
}

function rewrite(bytes, transform) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const json = JSON.parse(
    Buffer.from(bytes.subarray(32, 32 + view.getUint32(8, true))).toString("utf8"),
  );
  transform(json);
  const encoded = Buffer.from(JSON.stringify(json));
  const payload = bytes.subarray(view.getUint32(16, true));
  const start = Math.ceil((32 + encoded.length) / 16) * 16;
  const output = new Uint8Array(start + payload.length);
  output.set(bytes.subarray(0, 32));
  const header = new DataView(output.buffer);
  header.setUint32(8, encoded.length, true);
  header.setUint32(16, start, true);
  header.setUint32(20, output.length, true);
  output.set(encoded, 32);
  output.set(payload, start);
  return output;
}

export function irNegativeFixtures(fixtures) {
  const single = fixtures.find((fixture) => fixture.id === "zero").bytes;
  const multiple = fixtures.find((fixture) => fixture.id === "fractional").bytes;
  const version = single.slice();
  new DataView(version.buffer).setUint16(4, 2, true);
  return [
    { id: "version", bytes: version, code: "unsupported_version" },
    {
      id: "truncated",
      bytes: single.subarray(0, single.length - 1),
      code: "container_length_mismatch",
    },
    {
      id: "unknown-field",
      bytes: rewrite(single, (value) => {
        value.future = 1;
      }),
      code: "invalid_json",
    },
    {
      id: "unsafe-integer",
      bytes: rewrite(single, (value) => {
        value.header.project_revision = Number.MAX_SAFE_INTEGER + 1;
      }),
      code: "invalid_safe_integer",
    },
    {
      id: "overlap",
      bytes: rewrite(multiple, (value) => {
        value.blobs[1].byte_offset = 0;
      }),
      code: "blob_overlap",
    },
    {
      id: "invalid-resource-hash",
      bytes: rewrite(single, (value) => {
        value.resources = ["z".repeat(64)];
      }),
      code: "invalid_resource",
    },
  ];
}

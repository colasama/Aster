import assert from "node:assert/strict";

/** Bind every independently observed text sample to its production request and routing decision. */
export function auditTextRouting(receipt, observed, runtimeSha) {
  assert.equal(receipt.retained_sha256, receipt.response_sha256);
  const text = receipt.requests.operations
    .filter((o) => o.kind === "raster" && o.request.kind === "text")
    .map((o) => o.request);
  const retained = receipt.retained.operations
    .filter((o) => o.kind === "raster" && o.request.kind === "text")
    .map((o) => o.request);
  const remaining = observed.records.slice();
  const matched = new Map();
  for (const request of text) {
    const records = [];
    for (const time of request.exposure?.samples.map((s) => s.localTime) ?? [request.sourceTime]) {
      const index = remaining.findIndex(
        (r) =>
          r.composition === request.compositionId &&
          r.layer === request.layerId &&
          r.instance === request.instanceId &&
          Math.abs(r.local_time - time) <= 1e-10,
      );
      assert(index >= 0, `Unobserved production text request: ${request.instanceId}@${time}`);
      const [record] = remaining.splice(index, 1);
      assert(Math.abs(record.requested_scale - request.resolutionScale) <= 1e-8);
      assert.equal(record.temporal, Boolean(request.exposure));
      records.push(record);
    }
    matched.set(request.instanceId, { request, records });
  }
  assert.equal(remaining.length, 0, "Production routing omitted observed text samples");
  const native = receipt.routes.filter((r) => r.frame !== null);
  assert.equal(native.length, receipt.native_inputs);
  const nativeIds = new Set(native.map((r) => r.instance_id));
  assert.equal(nativeIds.size, native.length, "Duplicate native text owner");
  assert.deepEqual(
    receipt.retained.operations,
    receipt.requests.operations.filter(
      (o) =>
        !(o.kind === "raster" && o.request.kind === "text" && nativeIds.has(o.request.instanceId)),
    ),
    "Partition changed unrelated resource operations",
  );
  assert.deepEqual(receipt.retained.header, receipt.requests.header);
  assert.deepEqual(receipt.retained.surfaceBindings, receipt.requests.surfaceBindings);
  assert.deepEqual(receipt.retained.diagnostics, receipt.requests.diagnostics);
  assert.deepEqual(
    retained,
    text.filter((r) => !nativeIds.has(r.instanceId)),
  );
  const reasons = {},
    result = {
      records: observed.records.length,
      requests: text.length,
      native: native.length,
      retained: retained.length,
      exact_pixels: 0,
      temporal_samples: 0,
      native_records: [],
      reasons,
    };
  for (const [instance, { request, records }] of matched) {
    const routes = receipt.routes.filter((r) => r.instance_id === instance);
    assert(routes.length > 0, "Text capability decision absent");
    for (const route of routes) {
      assert.equal(route.capability.project_sha256, runtimeSha);
      assert.equal(route.capability.request.composition, request.compositionId);
      assert.equal(route.capability.request.layer, request.layerId);
      assert(
        text.some(
          (r) =>
            r.instanceId === instance &&
            r.sourceTime === route.capability.request.source_time &&
            r.resolutionScale === route.capability.request.resolution_scale,
        ),
        "Capability request time or scale differs",
      );
      assert(route.capability.reason.length > 0);
      assert(Array.isArray(route.capability.fonts) && route.capability.fonts.length <= 16);
      for (const font of route.capability.fonts) {
        assert(typeof font.family === "string" && font.family.length > 0);
        assert(Array.isArray(font.face.sha256) && font.face.sha256.length === 32);
        assert(font.face.sha256.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
        assert(Number.isInteger(font.face.index) && font.face.index >= 0);
        assert(Array.isArray(font.variations) && font.variations.length <= 64);
        for (const [tag, value] of font.variations) {
          assert(tag.length === 4 && tag.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
          assert(Number.isFinite(value));
        }
      }
      if (route.frame !== null) assert(route.capability.fonts.length > 0);
      reasons[route.capability.reason] = (reasons[route.capability.reason] ?? 0) + 1;
    }
    if (nativeIds.has(instance)) {
      assert.equal(routes.length, 1);
      assert.equal(receipt.bindings[instance], routes[0].frame);
      result.native_records.push(
        ...records.map((r) => ({
          composition: r.composition,
          layer: r.layer,
          time: r.local_time,
          rgba_sha256: r.rgba_sha256,
        })),
      );
      continue;
    }
    const binding = receipt.bindings[instance];
    assert(binding, "Retained text binding absent");
    if (request.exposure) {
      const pass = receipt.temporal.find((p) => p.output === binding);
      assert(pass, "Retained temporal pass absent");
      assert.deepEqual(
        pass.samples.map(([, weight]) => weight),
        request.exposure.samples.map((s) => s.weight),
        "Temporal weights or sample order differ",
      );
      assert(
        pass.samples.every(
          ([hash, weight]) => receipt.pixels.some((p) => p.frame === hash) && weight >= 0,
        ),
      );
      result.temporal_samples += records.length;
      continue;
    }
    const pixel = receipt.pixels.find((p) => p.frame === binding),
      record = records[0].retained_reference;
    assert(pixel, "Retained pixels absent");
    assert(record, "Production-sampled retained reference absent");
    assert.equal(record.source_time, request.sourceTime);
    assert.equal(record.frame_rate, request.frameRate);
    assert.equal(pixel.width, record.width);
    assert.equal(pixel.height, record.height);
    assert.deepEqual(pixel.bounds, [
      record.bounds.x,
      record.bounds.y,
      record.bounds.width,
      record.bounds.height,
    ]);
    assert.equal(
      pixel.rgba_sha256,
      record.gpu_rgba_sha256,
      `Retained text pixels changed: ${instance}`,
    );
    result.exact_pixels++;
  }
  assert(
    receipt.routes.every((r) => matched.has(r.instance_id)),
    "Extraneous text route",
  );
  return result;
}

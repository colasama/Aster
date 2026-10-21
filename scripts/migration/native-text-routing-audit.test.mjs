import assert from "node:assert/strict";
import test from "node:test";
import { auditTextRouting } from "./native-text-routing-audit.mjs";

function fixture() {
  const request = {
    compositionId: "comp",
    layerId: "layer",
    instanceId: "root/layer",
    kind: "text",
    sourceTime: 1,
    frameRate: 30,
    resolutionScale: 1,
    exposure: null,
  };
  const requests = {
    header: { snapshot_scope: "scope" },
    operations: [
      { kind: "raster", request },
      { kind: "target", target: { id: "surface" } },
    ],
    surfaceBindings: {},
    diagnostics: [],
  };
  const receipt = {
    requests,
    retained: structuredClone(requests),
    retained_sha256: "digest",
    response_sha256: "digest",
    native_inputs: 0,
    routes: [
      {
        instance_id: "root/layer",
        frame: null,
        capability: {
          project_sha256: "project",
          request: { composition: "comp", layer: "layer", source_time: 1, resolution_scale: 1 },
          reason: "font unavailable",
        },
      },
    ],
    bindings: { "root/layer": "frame" },
    pixels: [
      { frame: "frame", rgba_sha256: "gpu-pixels", width: 2, height: 2, bounds: [0, 0, 2, 2] },
    ],
    temporal: [],
  };
  const observed = {
    records: [
      {
        composition: "comp",
        layer: "layer",
        instance: "root/layer",
        local_time: 1,
        requested_scale: 1,
        temporal: false,
        width: 2,
        height: 2,
        bounds: { x: 0, y: 0, width: 2, height: 2 },
        rgba_sha256: "canvas-pixels",
        gpu_rgba_sha256: "gpu-pixels",
        retained_reference: {
          source_time: 1,
          frame_rate: 30,
          width: 2,
          height: 2,
          bounds: { x: 0, y: 0, width: 2, height: 2 },
          gpu_rgba_sha256: "gpu-pixels",
        },
      },
    ],
  };
  return { receipt, observed };
}

test("routing audit binds actual GPU pixels, complete requests and exact capabilities", () => {
  const { receipt, observed } = fixture();
  assert.equal(auditTextRouting(receipt, observed, "project").exact_pixels, 1);
  for (const mutate of [
    (r) => r.requests.operations.shift(),
    (r) => r.retained.operations.pop(),
    (r) => {
      r.requests.operations[0].request.frameRate = 60;
      r.retained.operations[0].request.frameRate = 60;
    },
    (r) => (r.response_sha256 = "forged"),
    (r) => (r.routes[0].capability.project_sha256 = "other"),
    (r) => (r.routes[0].capability.request.source_time = 2),
    (r) => (r.routes[0].capability.reason = ""),
    (r) => (r.pixels[0].rgba_sha256 = "canvas-pixels"),
    (r) => (r.pixels[0].bounds[0] = 1),
    (r) => (r.routes = []),
  ]) {
    const altered = structuredClone(receipt);
    mutate(altered);
    assert.throws(() => auditTextRouting(altered, observed, "project"));
  }
});

test("temporal routing preserves sample order and weights without claiming union pixel acceptance", () => {
  const { receipt, observed } = fixture();
  receipt.requests.operations[0].request.exposure = { samples: [{ localTime: 1, weight: 0.75 }] };
  receipt.retained = structuredClone(receipt.requests);
  receipt.temporal = [{ output: "frame", samples: [["sample", 0.75]] }];
  receipt.pixels[0].frame = "sample";
  observed.records[0].temporal = true;
  assert.equal(auditTextRouting(receipt, observed, "project").temporal_samples, 1);
  receipt.temporal[0].samples[0][1] = 1;
  assert.throws(() => auditTextRouting(receipt, observed, "project"));
});

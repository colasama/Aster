import assert from "node:assert/strict";
import test from "node:test";
import { matchQualifiedText } from "./native-project-text-qualification.mjs";

function fixture() {
  const capability = {
    stage: "native-glyph",
    project_sha256: "runtime",
    reason: "admitted",
    fonts: [{ family: "Segoe UI", face: { sha256: "font", index: 0 }, variations: [] }],
    request: {
      composition: "composition",
      layer: "layer",
      resolution_scale: 1,
      locale: "en-US",
      bounds: { x: 0, y: 0, width: 180, height: 44 },
      source_time: 0,
      maximum_dimension: 4096,
    },
  };
  const pair = {
    case_id: "text",
    authored_sha256: "project",
    instance_id: "root/layer",
    capability,
    reference_gpu_sha256: "reference",
    candidate_gpu_sha256: "native",
    width: 180,
    height: 44,
    bounds: capability.request.bounds,
    observation: { path: "observation", sha256: "proof" },
    comparison: "review",
  };
  const qualification = { gate: { path: "gate", sha256: "gate-proof" }, pairs: [pair] };
  const candidate = {
    case_id: pair.case_id,
    authored_sha256: pair.authored_sha256,
    reference_gpu_sha256: pair.reference_gpu_sha256,
    candidate_gpu_sha256: pair.candidate_gpu_sha256,
    width: pair.width,
    height: pair.height,
    bounds: [0, 0, 180, 44],
    time: 0,
    route: { instance_id: pair.instance_id, capability: structuredClone(capability) },
  };
  return { qualification, candidate };
}

test("only the authenticated unchanged glyph pair may span sample times", () => {
  const { qualification, candidate } = fixture();
  candidate.time = 0.75;
  candidate.route.capability.request.source_time = 0.75;
  candidate.route.capability.request.maximum_dimension = 8192;
  assert.deepEqual(matchQualifiedText(qualification, candidate), {
    gate: qualification.gate,
    observation: qualification.pairs[0].observation,
    comparison: "review",
  });
});

test("a glyph review cannot authorize changed pixels, fonts, projects or layout", () => {
  const mutations = [
    (c) => {
      c.reference_gpu_sha256 = "wrong";
    },
    (c) => {
      c.candidate_gpu_sha256 = "wrong";
    },
    (c) => {
      c.case_id = "wrong";
    },
    (c) => {
      c.authored_sha256 = "wrong";
    },
    (c) => {
      c.route.instance_id = "wrong";
    },
    (c) => {
      c.route.capability.project_sha256 = "wrong";
    },
    (c) => {
      c.route.capability.stage = "fallback";
    },
    (c) => {
      c.route.capability.reason = "wrong";
    },
    (c) => {
      c.route.capability.fonts[0].face.sha256 = "wrong";
    },
    (c) => {
      c.route.capability.fonts[0].variations = [{ tag: "wght", value: 400 }];
    },
    (c) => {
      c.route.capability.request.layer = "wrong";
    },
    (c) => {
      c.route.capability.request.composition = "wrong";
    },
    (c) => {
      c.route.capability.request.locale = "wrong";
    },
    (c) => {
      c.route.capability.request.resolution_scale = 2;
    },
    (c) => {
      c.route.capability.request.source_time = 1;
    },
    (c) => {
      c.route.capability.request.maximum_dimension = 128;
    },
    (c) => {
      c.route.capability.request.bounds.x = 1;
    },
    (c) => {
      c.bounds[0] = 1;
    },
    (c) => {
      c.width++;
    },
    (c) => {
      c.height++;
    },
  ];
  for (const mutate of mutations) {
    const { qualification, candidate } = fixture();
    mutate(candidate);
    assert.throws(() => matchQualifiedText(qualification, candidate));
  }
});

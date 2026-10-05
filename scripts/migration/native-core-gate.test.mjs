import assert from "node:assert/strict";
import test from "node:test";
import { coreGeometryCases, validateNativeReceipt } from "./native-core-gate.mjs";
import { selectRequiredGates } from "./performance-policy.mjs";

test("native execution receipts reject foreign plans, pixels, dimensions and adapters", () => {
  const expected = {
    plan_sha256: "a".repeat(64),
    rgba_sha256: "b".repeat(64),
    width: 320,
    height: 180,
    adapter: { name: "test GPU", vendorId: 1, deviceId: 2 },
  };
  const receipt = {
    schema_version: 1,
    status: "passed",
    native_gpu_execution: true,
    diagnostic_readback: true,
    plan_sha256: expected.plan_sha256,
    rgba_sha256: expected.rgba_sha256,
    width: 320,
    height: 180,
    adapter: {
      name: "test GPU",
      vendor: 1,
      device: 2,
      device_type: "IntegratedGpu",
      backend: "Dx12",
    },
  };
  validateNativeReceipt(receipt, expected);
  for (const change of [
    (value) => {
      value.native_gpu_execution = false;
    },
    (value) => {
      value.plan_sha256 = "c".repeat(64);
    },
    (value) => {
      value.rgba_sha256 = "c".repeat(64);
    },
    (value) => {
      value.width = 1;
    },
    (value) => {
      value.adapter.device = 3;
    },
    (value) => {
      value.adapter.device_type = "Cpu";
    },
    (value) => {
      value.adapter.backend = "BrowserWebGpu";
    },
  ]) {
    const changed = structuredClone(receipt);
    change(changed);
    assert.throws(() => validateNativeReceipt(changed, expected));
  }
});

test("native core gates cannot omit IR or pixels, and geometry coverage includes every AA mode", () => {
  for (const gates of [["G0"], ["G0", "G3"], ["G0", "G1"], ["G0", "G1", "G3", "G3"]]) {
    assert.throws(() => selectRequiredGates({ id: "M3", gates }), /M3 requires/);
  }
  assert.deepEqual(selectRequiredGates({ id: "M3", gates: ["G0", "G1", "G3"] }).required_gates, [
    "G0",
    "G1",
    "G3",
  ]);
  assert.equal(new Set(coreGeometryCases).size, coreGeometryCases.length);
  for (const mode of ["off", "fxaa", "ssaa2x", "ssaa4x"])
    assert(coreGeometryCases.includes(`aa-${mode}`));
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { performanceEligibility } from "./eligibility.mjs";

const approved = JSON.parse(
  await readFile(
    new URL("../../benchmarks/hardware/windows-radeon780m-local.json", import.meta.url),
    "utf8",
  ),
);

function fixture() {
  const manifest = structuredClone(approved);
  const expected = manifest.baselinePolicy.requiredAdapter;
  const adapter = { ...expected.webgpu };
  const device = {
    vendorId: expected.vendorId,
    deviceId: expected.deviceId,
    deviceString: expected.name,
    driverVersion: expected.driverVersion,
  };
  return {
    hardware: structuredClone(manifest),
    hardwareAfter: structuredClone(manifest),
    manifest,
    adapter,
    host: {
      backend: "browser-webgpu",
      native_backend: null,
      cacheIdentity: {
        platform: manifest.platform,
        architecture: manifest.operatingSystem.processArchitecture,
        os_release: manifest.operatingSystem.version,
        backend: "browser-webgpu",
        webgpuAdapter: { ...adapter },
        devices: [
          { ...device, active: true },
          { ...device, active: false },
        ],
        fonts: { status: "available", sha256: "a".repeat(64), count: 282 },
      },
    },
    diagnostics: [
      {
        available: true,
        architecture: adapter.architecture,
        description: `${adapter.vendor} · WebGPU`,
        gpuMemory: {
          adapterKey: JSON.stringify({
            vendor: adapter.vendor,
            device: adapter.device,
            description: adapter.description,
          }),
          device: { name: expected.name, vendorId: expected.vendorId, deviceId: expected.deviceId },
        },
      },
    ],
    sourceUnchanged: true,
    hardwareUnchanged: true,
    diagnostic: false,
    skipped: [],
  };
}

test("manifest-matched hardware, driver and renderer identity qualify without a thermal claim", () => {
  const result = performanceEligibility(fixture());
  assert.equal(result.eligible, true);
  assert.equal(result.adapter_verified, true);
  assert.deepEqual(result.reasons, []);
  assert(result.limitations.some((value) => value.includes("not independently measured")));
  assert(result.limitations.some((value) => value.includes("not enumerated")));
});

test("ANGLE active adapter alone cannot qualify fallback or missing WebGPU identity", () => {
  for (const flag of [true, undefined]) {
    const input = fixture();
    input.adapter.isFallbackAdapter = flag;
    input.host.cacheIdentity.webgpuAdapter.isFallbackAdapter = flag;
    const result = performanceEligibility(input);
    assert.equal(result.eligible, false);
    assert.equal(result.adapter_verified, false);
    assert(result.reasons.includes("fallback-or-unknown-webgpu-adapter"));
  }
});

test("a different AMD device remains ineligible even with matching WebGPU vendor and architecture", () => {
  const input = fixture();
  input.host.cacheIdentity.devices.push({ ...input.host.cacheIdentity.devices[0], deviceId: 9999 });
  assert(
    performanceEligibility(input).reasons.includes("native-gpu-or-driver-unmatched-or-ambiguous"),
  );
  input.host.cacheIdentity.devices = [
    { ...input.host.cacheIdentity.devices[0], driverVersion: "new-driver" },
  ];
  assert(
    performanceEligibility(input).reasons.includes("native-gpu-or-driver-unmatched-or-ambiguous"),
  );
});

test("every measured renderer needs a bound DXGI memory identity, including string PCI values", () => {
  const input = fixture();
  input.diagnostics[0].gpuMemory.device.vendorId = "0x1002";
  input.diagnostics[0].gpuMemory.device.deviceId = "6400";
  assert.equal(performanceEligibility(input).eligible, true);
  input.diagnostics.push({ ...input.diagnostics[0], gpuMemory: undefined });
  assert.equal(performanceEligibility(input).eligible, false);
  input.diagnostics.pop();
  input.diagnostics[0].gpuMemory.adapterKey = JSON.stringify({ vendor: "other" });
  assert(
    performanceEligibility(input).reasons.includes("renderer-0-memory-device-not-bound-to-webgpu"),
  );
});

test("post-run hardware and AC are independently checked even if unchanged flags claim true", () => {
  for (const change of [
    (value) => {
      value.power.acConnected = false;
    },
    (value) => {
      value.displays[0].refreshHz = 60;
    },
    (value) => {
      value.graphicsAdapters[0].driverVersion = "changed";
    },
    (value) => {
      value.operatingSystem.build = "changed";
    },
    (value) => {
      value.power.activeSchemeGuid = "changed";
    },
    (value) => {
      value.collection.status = "partial";
    },
  ]) {
    const input = fixture();
    change(input.hardwareAfter);
    assert.equal(performanceEligibility(input).eligible, false);
  }
});

test("scope, missing work, source drift and absent font provenance cannot form a baseline", () => {
  for (const change of [
    (value) => {
      value.diagnostic = true;
    },
    (value) => {
      value.skipped = [{}];
    },
    (value) => {
      value.sourceUnchanged = false;
    },
    (value) => {
      value.hardwareUnchanged = false;
    },
    (value) => {
      value.diagnostics = [];
    },
    (value) => {
      value.host.cacheIdentity.fonts = { status: "unavailable" };
    },
    (value) => {
      value.host.cacheIdentity.os_release = "10.0.99999";
    },
  ]) {
    const input = fixture();
    change(input);
    assert.equal(performanceEligibility(input).eligible, false);
  }
});

test("unknown manifests and incorrect explicit adapter overrides fail closed", () => {
  const input = fixture();
  input.manifest.id = "unapproved-machine";
  assert.equal(performanceEligibility(input).eligible, false);
  input.manifest.id = approved.id;
  input.adapter = { ...input.adapter, vendor: "nvidia" };
  assert.equal(performanceEligibility(input).eligible, false);
  delete input.adapter;
  assert.equal(performanceEligibility(input).eligible, true);
});

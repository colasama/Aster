import assert from "node:assert/strict";
import test from "node:test";
import { capturePerformanceHardware, hardwareQuery } from "./hardware.mjs";

function data() {
  return {
    operatingSystem: {
      name: "Windows",
      version: "10.0.19044",
      build: "19044",
      architecture: "64-bit",
    },
    cpu: [{ name: "Test CPU", physicalCores: 8, logicalProcessors: 16 }],
    memoryModules: [{ capacityBytes: 16_000_000_000, configuredClockMHz: 5600 }],
    totalVisibleBytes: 15_000_000_000,
    graphicsAdapters: [{ name: "Test GPU", driverVersion: "32.0.1" }],
    displays: [
      {
        primary: true,
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
        refreshHz: 60,
        bitsPerPixel: 32,
        orientation: 0,
      },
    ],
    acConnected: true,
    activeSchemeGuid: "381b4222-f694-41f0-9685-ff5bb260df2e",
    errors: [],
  };
}

async function capture(raw, extra = {}) {
  return capturePerformanceHardware("D:\\fixture", {
    platform: "win32",
    architecture: "x64",
    now: () => "2026-10-03T00:00:00.000Z",
    execFile: async () => ({ stdout: JSON.stringify(raw) }),
    ...extra,
  });
}

test("actual scheme and connected AC establish only explicitly scoped inventory eligibility", async () => {
  const result = await capture(data());
  assert.equal(result.collection.status, "complete");
  assert.equal(result.runConditions.baselineEligible, true);
  assert.equal(result.power.activeSchemeName, "Balanced");
  assert.equal(result.power.windowsPowerMode, null);
  assert.equal(result.runConditions.adapterSelectionVerified, false);
  assert.equal(result.runConditions.backgroundWorkloadsVerified, false);
  assert.equal(result.runConditions.thermalStateVerified, false);
  assert.equal(result.displays[0].x, -1920);
  assert.equal(result.memory.physicalBytes, 16_000_000_000);
});

test("both disconnected and unknown AC prevent baseline eligibility", async () => {
  for (const state of [false, null, undefined, "true", 1]) {
    const result = await capture({ ...data(), acConnected: state });
    assert.equal(result.runConditions.baselineEligible, false);
    assert.equal(result.power.acConnected, state === false ? false : null);
    assert(
      result.runConditions.reasons.includes(
        state === false ? "ac-power-disconnected" : "ac-power-unknown",
      ),
    );
  }
});

test("privacy whitelist discards identifiers, user-labelled power scheme names, and raw errors", async () => {
  const raw = data();
  raw.Hostname = "PRIVATE_HOST";
  raw.UserName = "PRIVATE_USER";
  raw.cpu[0].SerialNumber = "PRIVATE_SERIAL";
  raw.graphicsAdapters[0].PNPDeviceID = "PRIVATE_INSTANCE";
  raw.displays[0].DeviceID = "PRIVATE_MONITOR";
  raw.activeSchemeName = "PRIVATE_USER power plan";
  raw.errors.push("C:\\Users\\PRIVATE_USER\\failure", "Win32_PhysicalMemory");
  const result = await capture(raw);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assert.deepEqual(result.collection.errors, ["Win32_PhysicalMemory"]);
  assert.equal(result.collection.status, "partial");
  assert.equal(result.runConditions.baselineEligible, false);
});

test("unknown display refresh, inventory and scheme fields stay null and ineligible", async () => {
  const raw = data();
  raw.displays[0].refreshHz = 1;
  raw.graphicsAdapters[0].driverVersion = undefined;
  raw.memoryModules[0].capacityBytes = 0;
  raw.activeSchemeGuid = "not-a-guid";
  const result = await capture(raw);
  assert.equal(result.displays[0].refreshHz, null);
  assert.equal(result.graphicsAdapters[0].driverVersion, null);
  assert.equal(result.memory.physicalBytes, null);
  assert.equal(result.power.activeSchemeGuid, null);
  assert.equal(result.power.activeSchemeName, null);
  assert.equal(result.runConditions.baselineEligible, false);
});

test("query runs as a hidden, bounded, noninteractive child without interpolating the checkout path", async () => {
  let calls = 0;
  await capture(data(), {
    execFile: async (file, args, options) => {
      calls += 1;
      assert.match(file, /powershell\.exe$/);
      assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      assert.equal(Buffer.from(args[3], "base64").toString("utf16le"), hardwareQuery);
      assert.equal(options.cwd, "D:\\fixture");
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 256 * 1024);
      assert.doesNotMatch(
        hardwareQuery,
        /Set-CimInstance|Stop-Process|taskkill|\/setactive|\/setacvalueindex/i,
      );
      return { stdout: JSON.stringify(data()) };
    },
  });
  assert.equal(calls, 1);
});

test("failed, timed out, and malformed queries do not expose child diagnostics", async () => {
  for (const execFile of [
    async () => {
      throw new Error("C:\\Users\\PRIVATE_USER\\cmd failed");
    },
    async () => ({ stdout: "invalid JSON with PRIVATE_HOST" }),
  ]) {
    const result = await capture(data(), { execFile });
    assert.equal(result.collection.status, "partial");
    assert.equal(result.runConditions.baselineEligible, false);
    assert.deepEqual(result.collection.errors, ["hardware-query-failed"]);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
    assert.equal(result.power.acConnected, null);
  }
});

test("non-Windows capture stays unavailable without launching platform commands", async () => {
  const result = await capture(data(), {
    platform: "linux",
    execFile: () => assert.fail("Unsupported platforms cannot run Windows commands"),
  });
  assert.equal(result.platform, "linux");
  assert.equal(result.runConditions.baselineEligible, false);
  assert.equal(result.power.activeSchemeGuid, null);
  assert.deepEqual(result.collection.errors, ["unsupported-platform"]);
});

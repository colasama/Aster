import { isDeepStrictEqual } from "node:util";

function ordered(value) {
  return Array.isArray(value)
    ? [...value].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    : null;
}

function inventory(value) {
  return {
    platform: value?.platform,
    operatingSystem: value?.operatingSystem,
    cpu: ordered(value?.cpu),
    memory: value?.memory ? { ...value.memory, modules: ordered(value.memory.modules) } : null,
    graphicsAdapters: ordered(value?.graphicsAdapters),
    displays: value?.displays,
    power: value?.power,
  };
}

function pciId(value) {
  if (typeof value === "string" && /^(?:0x[\da-f]+|\d+)$/i.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff ? value : null;
}

function webgpuIdentity(value) {
  if (
    !value ||
    ["vendor", "architecture", "device", "description"].some(
      (key) => typeof value[key] !== "string",
    )
  )
    return null;
  return {
    vendor: value.vendor,
    architecture: value.architecture,
    device: value.device,
    description: value.description,
    isFallbackAdapter: value.isFallbackAdapter,
  };
}

/** Eligibility is evidence binding, not a claim that thermal or unrelated process activity was measured. */
export function performanceEligibility({
  hardware,
  hardwareAfter,
  host,
  adapter,
  diagnostics,
  manifest,
  sourceUnchanged,
  hardwareUnchanged,
  diagnostic,
  skipped,
}) {
  const reasons = [];
  const reject = (condition, reason) => {
    if (!condition) reasons.push(reason);
  };
  const policy = manifest?.baselinePolicy;
  const expected = policy?.requiredAdapter;
  const validManifest =
    manifest?.schemaVersion === 1 &&
    (manifest.id === "windows-radeon780m-local" ||
      (manifest.id === "windows-radeon780m-local-1920x1080-144hz" &&
        manifest.parentSeries === "windows-radeon780m-local" &&
        policy?.driverOsPowerDisplayChangesStartNewSeries === true &&
        manifest.displays?.length === 1 &&
        manifest.displays[0].width === 1920 &&
        manifest.displays[0].height === 1080 &&
        manifest.displays[0].refreshHz === 144)) &&
    typeof expected?.name === "string" &&
    expected.name.length > 0 &&
    pciId(expected.vendorId) !== null &&
    pciId(expected.deviceId) !== null &&
    typeof expected.driverVersion === "string" &&
    expected.driverVersion.length > 0 &&
    webgpuIdentity(expected.webgpu)?.isFallbackAdapter === false &&
    manifest.platform === "win32" &&
    manifest.power?.acConnected === true &&
    policy.historicalRtx5060ComparisonsAllowed === false;
  reject(validManifest, "unrecognized-or-incomplete-hardware-manifest");
  reject(sourceUnchanged === true, "source-or-resources-changed");
  reject(hardwareUnchanged === true, "hardware-or-run-conditions-changed");
  reject(diagnostic === false, "diagnostic-or-unspecified-scope");
  reject(Array.isArray(skipped) && skipped.length === 0, "required-workloads-skipped");
  for (const [name, value] of [
    ["before", hardware],
    ["after", hardwareAfter],
  ]) {
    reject(
      value?.collection?.status === "complete" &&
        Array.isArray(value.collection.errors) &&
        value.collection.errors.length === 0,
      `${name}-hardware-capture-incomplete`,
    );
    reject(value?.power?.acConnected === true, `${name}-ac-power-not-confirmed`);
    reject(value?.runConditions?.baselineEligible === true, `${name}-hardware-ineligible`);
    reject(
      validManifest && isDeepStrictEqual(inventory(value), inventory(manifest)),
      `${name}-hardware-differs-from-manifest`,
    );
  }
  reject(
    isDeepStrictEqual(inventory(hardware), inventory(hardwareAfter)),
    "hardware-observations-differ",
  );
  const actual = webgpuIdentity(adapter ?? host?.cacheIdentity?.webgpuAdapter);
  const recorded = webgpuIdentity(host?.cacheIdentity?.webgpuAdapter);
  reject(actual?.isFallbackAdapter === false, "fallback-or-unknown-webgpu-adapter");
  reject(
    actual !== null && isDeepStrictEqual(actual, recorded),
    "webgpu-identity-differs-from-host",
  );
  reject(
    validManifest && isDeepStrictEqual(actual, webgpuIdentity(expected.webgpu)),
    "webgpu-adapter-differs-from-manifest",
  );
  reject(
    host?.backend === "browser-webgpu" &&
      host?.native_backend === null &&
      host?.cacheIdentity?.backend === "browser-webgpu",
    "unexpected-renderer-backend",
  );
  reject(
    host?.cacheIdentity?.platform === manifest?.platform &&
      host?.cacheIdentity?.os_release === manifest?.operatingSystem?.version &&
      host?.cacheIdentity?.architecture === manifest?.operatingSystem?.processArchitecture,
    "electron-host-differs-from-manifest",
  );
  const devices = Array.isArray(host?.cacheIdentity?.devices) ? host.cacheIdentity.devices : [];
  const vendorDevices = devices.filter(
    (device) => pciId(device.vendorId) === pciId(expected?.vendorId),
  );
  const identities = new Set(
    vendorDevices.map(
      (device) =>
        `${pciId(device.vendorId)}/${pciId(device.deviceId)}/${device.deviceString}/${device.driverVersion}`,
    ),
  );
  // Browser privacy hides PCI device strings here. Require one unambiguous vendor device and
  // the renderer's independently reported DXGI memory-device match, never ANGLE's active flag alone.
  const hardwareDevice = vendorDevices.find(
    (device) =>
      pciId(device.deviceId) === pciId(expected?.deviceId) &&
      device.deviceString === expected?.name &&
      device.driverVersion === expected?.driverVersion,
  );
  reject(
    validManifest && identities.size === 1 && Boolean(hardwareDevice),
    "native-gpu-or-driver-unmatched-or-ambiguous",
  );
  const fonts = host?.cacheIdentity?.fonts;
  reject(
    fonts?.status === "available" &&
      /^[a-f0-9]{64}$/.test(fonts.sha256) &&
      Number.isSafeInteger(fonts.count) &&
      fonts.count > 0,
    "font-provenance-unavailable",
  );
  reject(Array.isArray(diagnostics) && diagnostics.length > 0, "renderer-diagnostics-missing");
  for (const [index, value] of (Array.isArray(diagnostics) ? diagnostics : []).entries()) {
    const device = value?.gpuMemory?.device;
    reject(
      validManifest &&
        value?.available === true &&
        value.architecture === actual?.architecture &&
        value.description ===
          `${actual?.vendor || "GPU"} · ${actual?.description || actual?.device || "WebGPU"}` &&
        pciId(device?.vendorId) === pciId(expected?.vendorId) &&
        pciId(device?.deviceId) === pciId(expected?.deviceId) &&
        device?.name === expected?.name,
      `renderer-${index}-gpu-identity-unverified`,
    );
    let key;
    try {
      key = JSON.parse(value?.gpuMemory?.adapterKey ?? "null");
    } catch {
      key = null;
    }
    reject(
      isDeepStrictEqual(
        key,
        actual
          ? { vendor: actual.vendor, device: actual.device, description: actual.description }
          : undefined,
      ),
      `renderer-${index}-memory-device-not-bound-to-webgpu`,
    );
  }
  return {
    eligible: reasons.length === 0,
    reasons,
    manifest_id: manifest?.id ?? null,
    adapter_verified:
      validManifest &&
      actual?.isFallbackAdapter === false &&
      !reasons.some((reason) => /gpu|backend|renderer/.test(reason)),
    evidence: {
      webgpu_adapter: actual,
      hardware_adapter: hardwareDevice
        ? {
            name: hardwareDevice.deviceString,
            vendor_id: pciId(hardwareDevice.vendorId),
            device_id: pciId(hardwareDevice.deviceId),
            driver_version: hardwareDevice.driverVersion,
          }
        : null,
      renderer_diagnostic_count: Array.isArray(diagnostics) ? diagnostics.length : 0,
      ac_confirmed_before_and_after:
        hardware?.power?.acConnected === true && hardwareAfter?.power?.acConnected === true,
    },
    limitations: [
      "Warm-up completion is validated from workload results; temperature is not independently measured",
      "Unrelated background workloads are not enumerated, terminated or asserted absent",
      "Windows power-mode overlay remains unobserved; the recorded active scheme is the baseline condition",
      "WebGPU exposes vendor/architecture only on this host; PCI identity uses an unambiguous native-device and renderer-memory match",
    ],
  };
}

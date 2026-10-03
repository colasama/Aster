import { release } from "node:os";

export function captureHostInfo(gpuInfo, gpuFeatureStatus, versions = process.versions) {
  const devices = (gpuInfo.gpuDevice ?? []).map((device) =>
    Object.fromEntries(
      [
        "active",
        "vendorId",
        "deviceId",
        "deviceString",
        "driverVendor",
        "driverVersion",
        "driverDate",
      ].map((key) => [key, device[key] ?? null]),
    ),
  );
  const attributes = gpuInfo.auxAttributes ?? {};
  return {
    backend: "browser-webgpu",
    native_backend: null,
    gpu_info: gpuInfo,
    gpu_feature_status: gpuFeatureStatus,
    cacheIdentity: {
      platform: process.platform,
      architecture: process.arch,
      os_release: release(),
      electron: versions.electron ?? null,
      chromium: versions.chrome ?? null,
      backend: "browser-webgpu",
      devices,
      driver: {
        glRenderer: attributes.glRenderer ?? null,
        glVersion: attributes.glVersion ?? null,
        displayType: attributes.displayType ?? null,
      },
      gpuPreference: "high-performance",
    },
  };
}

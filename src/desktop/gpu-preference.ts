import { logger } from "../core/logger";
import { normalizeGpuPreference } from "../core/rendering/gpu-preference";

export function readBrowserGpuPreference() {
  try {
    return normalizeGpuPreference(window.localStorage.getItem("aster.gpuPreference"));
  } catch {
    return normalizeGpuPreference(undefined);
  }
}

/** Shared by preview, export hosts, and memory detection when requesting an adapter. */
export async function requestPreferredGpuAdapter(): Promise<GPUAdapter | null> {
  let powerPreference = readBrowserGpuPreference();
  if (window.asterDesktop?.getPreferences) {
    try {
      powerPreference = normalizeGpuPreference(
        (await window.asterDesktop.getPreferences()).gpuPreference,
      );
    } catch (error) {
      logger.warn("gpu", "preferences_unavailable", undefined, error);
    }
  }
  return navigator.gpu.requestAdapter({ powerPreference });
}

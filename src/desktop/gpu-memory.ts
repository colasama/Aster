import { logger } from "../core/logger";
import {
  type GpuAdapterIdentity,
  type GpuMemorySnapshot,
  isGpuMemoryBudget,
  matchGpuMemoryDevice,
} from "../core/rendering/gpu-memory-policy";

export const GPU_MEMORY_CHANGED_EVENT = "aster:gpu-memory-changed";
let identity: GpuAdapterIdentity | undefined;
let snapshot: GpuMemorySnapshot | undefined;
let pending: Promise<GpuMemorySnapshot> | undefined;

export function currentGpuMemory(): GpuMemorySnapshot | undefined {
  return snapshot;
}

export async function detectGpuMemory(adapter?: GpuAdapterIdentity): Promise<GpuMemorySnapshot> {
  if (pending) {
    const current = await pending;
    if (!adapter || adapterKey(adapter) === current.adapterKey) return current;
    return detectGpuMemory(adapter);
  }
  if (adapter)
    identity = { vendor: adapter.vendor, device: adapter.device, description: adapter.description };
  pending = readMemory().finally(() => {
    pending = undefined;
  });
  return pending;
}

function adapterKey(adapter?: GpuAdapterIdentity): string {
  return JSON.stringify(
    adapter
      ? { vendor: adapter.vendor, device: adapter.device, description: adapter.description }
      : {},
  );
}

async function readMemory(): Promise<GpuMemorySnapshot> {
  try {
    if (!identity && typeof navigator !== "undefined" && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter)
        identity = {
          vendor: adapter.info.vendor,
          device: adapter.info.device,
          description: adapter.info.description,
        };
    }
    const devices = (await window.asterDesktop?.getGpuMemoryDevices?.()) ?? [];
    snapshot = {
      adapterKey: adapterKey(identity),
      detectedAt: Date.now(),
      device: identity ? matchGpuMemoryDevice(identity, devices) : undefined,
    };
  } catch (error) {
    logger.warn("gpu_memory", "detection_unavailable", undefined, error);
    snapshot = { adapterKey: adapterKey(identity), detectedAt: Date.now() };
  }
  return snapshot;
}

export async function initialRendererGpuMemory(adapter: GpuAdapterIdentity) {
  const [memory, preferences] = await Promise.all([
    detectGpuMemory(adapter),
    window.asterDesktop?.getPreferences?.().catch((error: unknown) => {
      logger.warn("gpu_memory", "preferences_unavailable", undefined, error);
      return undefined;
    }),
  ]);
  let preference: unknown = preferences?.gpuMemoryBudgetMb;
  if (preference === undefined) {
    try {
      preference = window.localStorage.getItem("aster.gpuMemoryBudgetMb");
    } catch {
      /* Storage may be unavailable in an isolated render host. */
    }
  }
  const parsed =
    typeof preference === "string" && preference !== "auto" ? Number(preference) : preference;
  return { memory, preference: isGpuMemoryBudget(parsed) ? parsed : ("auto" as const) };
}
